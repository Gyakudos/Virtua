import { shell } from 'electron'
import type { UpdateInfo } from '../shared/types'
import { BUILD_VERSION } from '../shared/version'

const REPO = 'Gyakudos/Virtua'
const API = `https://api.github.com/repos/${REPO}`

interface GitHubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string | null
}

interface GitHubTag {
  name: string
}

function parseVersion(value: string): number[] {
  return value.replace(/^v/i, '').trim().split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function versionIsNewer(current: string, latest: string): boolean {
  const left = parseVersion(current)
  const right = parseVersion(latest)
  const length = Math.max(left.length, right.length, 3)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (b > a) return true
    if (b < a) return false
  }
  return false
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Virtua-Update-Check',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    const error = new Error(`GitHub returned ${response.status} ${response.statusText}.`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response.json() as Promise<T>
}

/** Manual, opt-in GitHub check. No request is made until the user clicks the button. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  let release: GitHubRelease | null = null
  try {
    release = await getJson<GitHubRelease>('/releases/latest')
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status !== 404) throw error
  }

  if (!release) {
    const tags = await getJson<GitHubTag[]>('/tags?per_page=20')
    const latest = tags
      .map((tag) => tag.name)
      .filter((name) => parseVersion(name).length >= 2)
      .sort((a, b) => {
        const left = parseVersion(a)
        const right = parseVersion(b)
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          const difference = (right[index] ?? 0) - (left[index] ?? 0)
          if (difference !== 0) return difference
        }
        return 0
      })[0]
    if (!latest) {
      throw new Error('No GitHub release or version tag found yet. The first post should be tagged 000.0015.000.2026 (Major.Minor.Sub.Year).')
    }
    release = {
      tag_name: latest,
      name: `Virtua ${latest}`,
      body: 'No release notes were provided for this tag.',
      html_url: `https://github.com/${REPO}/releases/tag/${encodeURIComponent(latest)}`,
      published_at: null
    }
  }

  return {
    current: BUILD_VERSION,
    latest: release.tag_name.replace(/^v/i, ''),
    tag: release.tag_name,
    name: release.name || release.tag_name,
    notes: (release.body || 'No release notes provided.').slice(0, 4000),
    url: release.html_url,
    publishedAt: release.published_at,
    newer: versionIsNewer(BUILD_VERSION, release.tag_name)
  }
}

export async function openUpdate(url: string): Promise<void> {
  if (!url.startsWith(`https://github.com/${REPO}/`)) throw new Error('Refusing to open an untrusted update URL.')
  await shell.openExternal(url)
}
