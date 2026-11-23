import { z } from 'zod'
import type { ToolRisk } from '../shared/types'
import {
  controlApp, listConnectors, listWindows, readOperaBookmarks, readScreen, readVSCodeSettings
} from './connectors'
import { gitDiff, gitStatus, listRepos, readCodeFile, runAllowedCommand } from './dev'
import { searchLocalFiles } from './files'
import { ocrFile } from './images'
import { retrieve } from './rag'
import * as store from './storage'

export interface ToolDefinition {
  name: string
  description: string
  risk: ToolRisk
  schema: z.ZodTypeAny
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

export const tools: ToolDefinition[] = [
  {
    name: 'notes.create',
    description: 'Create a note with a title, content, and optional tags.',
    risk: 'write',
    schema: z.object({
      title: z.string().min(1).describe('Note title'),
      content: z.string().describe('Note body'),
      tags: z.array(z.string()).optional().describe('Optional tags')
    }),
    handler: (args) => store.createNote(
      args.title as string,
      (args.content as string) ?? '',
      (args.tags as string[]) ?? []
    )
  },
  {
    name: 'notes.search',
    description: 'Search saved notes by title, content, or tag.',
    risk: 'safe',
    schema: z.object({
      query: z.string().describe('Search text')
    }),
    handler: (args) => store.searchNotes(args.query as string)
  },
  {
    name: 'tasks.add',
    description: 'Add a task. Use ISO date text for dueAt if given.',
    risk: 'write',
    schema: z.object({
      title: z.string().min(1).describe('Task title'),
      dueAt: z.string().optional().describe('Optional due date as ISO text'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority')
    }),
    handler: (args) => store.createTask(
      args.title as string,
      (args.dueAt as string) ?? null,
      (args.priority as string) ?? 'normal'
    )
  },
  {
    name: 'tasks.list',
    description: 'List tasks, optionally filtered by status.',
    risk: 'safe',
    schema: z.object({
      status: z.enum(['open', 'done', 'all']).optional().describe('Status filter')
    }),
    handler: (args) => store.listTasks((args.status as string) ?? 'all')
  },
  {
    name: 'tasks.complete',
    description: 'Mark a task complete by its id or exact title.',
    risk: 'write',
    schema: z.object({
      idOrTitle: z.string().min(1).describe('Task id or title')
    }),
    handler: (args) => store.completeTask(args.idOrTitle as string)
  },
  {
    name: 'reminders.create',
    description: 'Create a reminder for the user.',
    risk: 'write',
    schema: z.object({
      title: z.string().min(1).describe('Reminder title'),
      fireAt: z.string().optional().describe('Optional ISO time to fire')
    }),
    handler: (args) => store.createReminder(args.title as string, (args.fireAt as string) ?? null)
  },
  {
    name: 'system.time',
    description: 'Get the current local date and time.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => ({ localTime: new Date().toLocaleString() })
  },
  {
    name: 'knowledge.search',
    description: 'Search the indexed local knowledge folders. Returns cited snippets.',
    risk: 'safe',
    schema: z.object({
      query: z.string().min(1).describe('What to look for in indexed files'),
      topK: z.number().int().min(1).max(10).optional().describe('Number of snippets (default 4)')
    }),
    handler: async (args) => retrieve(args.query as string, (args.topK as number) ?? 4)
  },
  {
    name: 'knowledge.sources',
    description: 'List the local folders currently indexed for knowledge search.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => store.listRagSources().map((source) => ({
      path: source.path, label: source.label, fileCount: source.fileCount, chunkCount: source.chunkCount
    }))
  },
  {
    name: 'files.search',
    description: 'Search local files by name and/or text content. Read-only, local-only, credential paths are blocked. Defaults to your home folder; pass an absolute root to search elsewhere.',
    risk: 'safe',
    schema: z.object({
      query: z.string().min(1).describe('Filename or text to look for (case-insensitive)'),
      root: z.string().optional().describe('Absolute folder or file to search. Defaults to the user home folder.'),
      mode: z.enum(['name', 'content', 'both']).optional().describe('Search names, file contents, or both (default both)'),
      extensions: z.array(z.string()).optional().describe('Optional extension filter, e.g. [".md", ".txt"]'),
      maxResults: z.number().int().min(1).max(50).optional().describe('Maximum results to return (default 20)')
    }),
    handler: (args) => searchLocalFiles({
      query: args.query as string,
      root: args.root as string | undefined,
      mode: args.mode as 'name' | 'content' | 'both' | undefined,
      extensions: args.extensions as string[] | undefined,
      maxResults: args.maxResults as number | undefined
    })
  },
  {
    name: 'images.ocr',
    description: 'Read text from a local image file with local OCR. Use for screenshots or pictures found on this device. Credential paths are blocked.',
    risk: 'safe',
    schema: z.object({
      path: z.string().min(1).describe('Absolute path to a local .png, .jpg, .jpeg, .bmp, .gif, or .webp image')
    }),
    handler: (args) => ocrFile(args.path as string)
  },
  {
    name: 'dev.repos',
    description: 'List repos/folders you have explicitly added for code work.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => listRepos()
  },
  {
    name: 'code.search',
    description: 'Search indexed source code and project documents.',
    risk: 'safe',
    schema: z.object({
      query: z.string().min(1).describe('Code or concept to find'),
      topK: z.number().int().min(1).max(10).optional().describe('Number of snippets (default 5)'),
      extension: z.string().optional().describe('Optional file extension filter, e.g. .ts')
    }),
    handler: async (args) => {
      const results = await retrieve(args.query as string, (args.topK as number) ?? 5)
      const extension = (args.extension as string | undefined)?.toLowerCase()
      return (extension ? results.filter((result) => result.path.toLowerCase().endsWith(extension)) : results)
    }
  },
  {
    name: 'code.read',
    description: 'Read a file from a repo/folder you added. Credential-like paths are blocked.',
    risk: 'safe',
    schema: z.object({
      path: z.string().min(1).describe('Absolute path inside an added repo/folder')
    }),
    handler: (args) => readCodeFile(args.path as string)
  },
  {
    name: 'git.status',
    description: 'Show local git status for an added repo (read-only).',
    risk: 'safe',
    schema: z.object({
      repoPath: z.string().min(1).describe('Absolute path of an added git repo')
    }),
    handler: (args) => gitStatus(args.repoPath as string)
  },
  {
    name: 'git.diff',
    description: 'Show local uncommitted git diff for an added repo (read-only).',
    risk: 'safe',
    schema: z.object({
      repoPath: z.string().min(1).describe('Absolute path of an added git repo'),
      statOnly: z.boolean().optional().describe('Return only the diff stat')
    }),
    handler: (args) => gitDiff(args.repoPath as string, (args.statOnly as boolean) ?? false)
  },
  {
    name: 'tests.run',
    description: 'Run an approved local test command in an added repo. Always asks for approval.',
    risk: 'sensitive',
    schema: z.object({
      repoPath: z.string().min(1).describe('Absolute path of an added repo'),
      command: z.string().min(1).describe('Allowed local command, e.g. npm test')
    }),
    handler: async (args) => {
      const result = await runAllowedCommand(args.repoPath as string, args.command as string)
      return { exitCode: result.exitCode, output: result.output.slice(-4000) }
    }
  },
  {
    name: 'connectors.list',
    description: 'List available local app connectors and whether each is granted.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => listConnectors()
  },
  {
    name: 'opera.bookmarks',
    description: 'Read local Opera bookmarks. Requires the Opera bookmarks connector to be granted.',
    risk: 'safe',
    schema: z.object({
      query: z.string().optional().describe('Optional filter for name, URL, or folder')
    }),
    handler: (args) => {
      const bookmarks = readOperaBookmarks()
      const query = ((args.query as string) ?? '').trim().toLowerCase()
      return query
        ? bookmarks.filter((item) => `${item.name} ${item.url} ${item.folder}`.toLowerCase().includes(query))
        : bookmarks
    }
  },
  {
    name: 'vscode.settings',
    description: 'Read local VS Code user settings and extensions. Requires connector grant.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => readVSCodeSettings()
  },
  {
    name: 'app.control',
    description: 'Open a file, folder, or URL in an approved local app. Always asks approval.',
    risk: 'write',
    schema: z.object({
      app: z.enum(['opera', 'vscode', 'notepad']).describe('App to launch'),
      target: z.string().min(1).describe('URL for Opera; file or folder path for VS Code/Notepad')
    }),
    handler: (args) => controlApp(args.app as 'opera' | 'vscode' | 'notepad', args.target as string)
  },
  {
    name: 'screen.windows',
    description: 'List window titles available for on-demand screen reading.',
    risk: 'safe',
    schema: z.object({}),
    handler: () => listWindows()
  },
  {
    name: 'screen.read',
    description: 'Capture one chosen window and OCR it locally. Requires grant and approval.',
    risk: 'sensitive',
    schema: z.object({
      sourceId: z.string().min(1).describe('Window id from screen.windows'),
      callId: z.string().min(1).describe('Unique id for this capture')
    }),
    handler: (args) => readScreen(args.sourceId as string, args.callId as string)
  }
]

function jsonParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}

export const toolSpecs = tools.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: jsonParameters(tool.schema)
  }
}))

export function findTool(name: string): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name)
}

export async function executeTool(name: string, args: unknown): Promise<unknown> {
  const tool = findTool(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)

  const parsed = tool.schema.safeParse(args ?? {})
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join('; ')
    throw new Error(`Invalid arguments for ${name}: ${details}`)
  }

  return Promise.resolve(tool.handler(parsed.data as Record<string, unknown>))
}
