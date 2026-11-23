import { isLocalHost } from './linkedApi'

export interface ParsedPairLink {
  url: string
  token: string
}

/** Parse the local-only QR payload produced by the desktop Portable Sync panel. */
export function parsePairLink(raw: string): ParsedPairLink {
  const value = raw.trim()
  if (!value) throw new Error('Empty pairing link.')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('That QR code is not a valid Virtua pairing link.')
  }

  const isDeepLink = parsed.protocol === 'virtua:'
  const isLocalLink = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  if (!isDeepLink && !isLocalLink) throw new Error('That QR code is not a Virtua pairing link.')
  if (isDeepLink && parsed.hostname !== 'pair') throw new Error('Unknown Virtua pairing link.')

  const host = (parsed.searchParams.get('host') || (isLocalLink ? parsed.hostname : '')).trim()
  const portRaw = (parsed.searchParams.get('port') || (isLocalLink ? parsed.port : '')).trim()
  const token = (parsed.searchParams.get('token') || '').trim()
  if (!host || !token) throw new Error('Pairing link is missing its address or token.')
  if (!isLocalHost(host)) throw new Error('Only LAN, mDNS, localhost, or Tailscale addresses are allowed.')

  const port = Number(portRaw) || 8787
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Pairing link has an invalid port.')
  return { url: `http://${host}:${port}`, token }
}
