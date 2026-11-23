import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { CommandResult, RepoInfo } from '../shared/types'
import { isCredentialPath } from './rag'
import * as store from './storage'

const COMMAND_TIMEOUT_MS = 180_000
const GIT_TIMEOUT_MS = 20_000
const MAX_OUTPUT = 20_000
const MAX_READ = 20_000

interface RunOptions {
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export function listRepos(): RepoInfo[] {
  return store.listRagSources().map((source) => ({
    path: source.path,
    label: source.label,
    isGit: existsSync(join(source.path, '.git')),
    fileCount: source.fileCount,
    chunkCount: source.chunkCount
  }))
}

export function assertAllowedRepo(repoPath: string): string {
  const target = resolve(repoPath)
  const normalized = target.toLowerCase()
  const allowed = store.listRagSources().some((source) => {
    const root = resolve(source.path).toLowerCase()
    return normalized === root || normalized.startsWith(root + sep.toLowerCase())
  })
  if (!allowed) {
    throw new Error('That path is outside the folders you added to Knowledge. Add the repo folder first.')
  }
  if (isCredentialPath(target)) throw new Error('That path is on the credential deny-list.')
  if (!existsSync(target)) throw new Error(`Path does not exist: ${target}`)
  return target
}

export function readCodeFile(path: string): { path: string; content: string; truncated: boolean } {
  const target = assertAllowedRepo(path)
  const content = readFileSync(target, 'utf8')
  return {
    path: target,
    content: content.slice(0, MAX_READ),
    truncated: content.length > MAX_READ
  }
}

function tokenize(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ''))
}

function assertSafeArguments(args: string[]): void {
  for (const arg of args.slice(1)) {
    if (arg.split(/[\\/]/).includes('..')) throw new Error('Parent path segments are not allowed in test commands.')
    if (/^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('/')) throw new Error('Absolute paths are not allowed in test commands.')
  }
}

export function assertAllowedCommand(command: string): string[] {
  if (/[\r\n;&|<>$\`]/.test(command)) throw new Error('Shell chaining, redirects, and variables are not allowed.')
  const args = tokenize(command.trim())
  const binary = args[0]
  const rest = args.slice(1)

  const allowed =
    (binary === 'npm' && (
      rest[0] === 'test' ||
      (rest[0] === 'run' && ['test', 'typecheck', 'build', 'lint', 'check'].includes(rest[1] ?? ''))
    )) ||
    (binary === 'node' && rest[0] === '--test') ||
    binary === 'pytest' ||
    ((binary === 'python' || binary === 'python3') && rest[0] === '-m' && rest[1] === 'pytest') ||
    (binary === 'cargo' && rest[0] === 'test') ||
    (binary === 'go' && rest[0] === 'test') ||
    (binary === 'dotnet' && rest[0] === 'test') ||
    (binary === 'vitest' || binary === 'jest') && (rest[0] === undefined || rest[0] === 'run')

  if (!allowed) {
    throw new Error(
      'Command not allowed. Use: npm test | npm run test|typecheck|build|lint|check | node --test | pytest | python -m pytest | cargo test | go test | dotnet test | vitest | jest'
    )
  }
  assertSafeArguments(args)
  return args
}

function spawnProcess(args: string[], cwd: string, options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    })

    let output = ''
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    const onCancel = (): void => { child.kill() }
    options.signal?.addEventListener('abort', onCancel, { once: true })

    const append = (chunk: Buffer): void => {
      const text = chunk.toString()
      output = (output + text).slice(-MAX_OUTPUT)
      options.onOutput?.(text)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    child.on('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCancel)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCancel)
      resolve({ exitCode: code, output })
    })
  })
}

export async function runAllowedCommand(
  repoPath: string,
  command: string,
  options: RunOptions = {}
): Promise<CommandResult> {
  const cwd = assertAllowedRepo(repoPath)
  const args = assertAllowedCommand(command)
  return spawnProcess(args, cwd, options)
}

export function gitStatus(repoPath: string): Promise<CommandResult> {
  return spawnProcess(['git', 'status', '--short', '--branch'], assertAllowedRepo(repoPath), {
    timeoutMs: GIT_TIMEOUT_MS
  })
}

export async function gitDiff(repoPath: string, statOnly = false): Promise<CommandResult> {
  const cwd = assertAllowedRepo(repoPath)
  if (statOnly) return spawnProcess(['git', 'diff', '--stat'], cwd, { timeoutMs: GIT_TIMEOUT_MS })
  const stat = await spawnProcess(['git', 'diff', '--stat'], cwd, { timeoutMs: GIT_TIMEOUT_MS })
  const diff = await spawnProcess(['git', 'diff', '--unified=3'], cwd, { timeoutMs: GIT_TIMEOUT_MS })
  return {
    exitCode: diff.exitCode ?? stat.exitCode,
    output: `${stat.output}\n${diff.output}`.slice(0, MAX_OUTPUT)
  }
}
