import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dialog } from 'electron'
import type { CalendarEvent, CalendarImportResult } from '../shared/types'
import * as store from './storage'

function unfold(lines: string[]): string[] {
  const unfolded: string[] = []
  for (const raw of lines) {
    if (/^[ \t]/.test(raw) && unfolded.length > 0) unfolded[unfolded.length - 1] += raw.slice(1)
    else if (raw.trim()) unfolded.push(raw)
  }
  return unfolded
}

function unescape(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_match, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char
  )
}

function splitProperty(line: string): { name: string; params: string; value: string } | null {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const semi = head.indexOf(';')
  return {
    name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(),
    params: semi < 0 ? '' : head.slice(semi + 1),
    value: line.slice(colon + 1)
  }
}

/** Converts a wall-clock time in an IANA timezone to a UTC epoch (DST-aware). */
function zonedTimeToUtc(parts: number[], timeZone: string): number {
  const [year, month, day, hour, minute, second] = parts
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const offsetAt = (instant: number): number => {
    const values = new Map<string, number>()
    for (const part of formatter.formatToParts(new Date(instant))) {
      if (part.type !== 'literal') values.set(part.type, Number(part.value))
    }
    return Date.UTC(
      values.get('year') ?? 1970,
      (values.get('month') ?? 1) - 1,
      values.get('day') ?? 1,
      values.get('hour') ?? 0,
      values.get('minute') ?? 0,
      values.get('second') ?? 0
    ) - instant
  }
  const firstGuess = wall - offsetAt(wall)
  return wall - offsetAt(firstGuess)
}

function parseIcsDate(value: string, params: string): { iso: string | null; allDay: boolean } {
  const clean = value.trim()
  if (/^\d{8}$/.test(clean)) {
    const year = Number(clean.slice(0, 4))
    const month = Number(clean.slice(4, 6))
    const day = Number(clean.slice(6, 8))
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? { iso: null, allDay: true } : { iso: date.toISOString(), allDay: true }
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(clean)
  if (!match) return { iso: null, allDay: false }
  const parts = [match[1], match[2], match[3], match[4], match[5], match[6]].map(Number)
  let epoch: number
  if (match[7]) {
    epoch = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])
  } else {
    const timeZone = /TZID=([^;:]+)/i.exec(params)?.[1]?.replace(/^"|"$/g, '') ?? ''
    if (timeZone) {
      try {
        epoch = zonedTimeToUtc(parts, timeZone)
      } catch {
        epoch = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime()
      }
    } else {
      epoch = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime()
    }
  }
  return Number.isFinite(epoch) ? { iso: new Date(epoch).toISOString(), allDay: false } : { iso: null, allDay: false }
}

/** Parses VEVENT blocks from local .ics text. Recurrence rules are not expanded. */
export function parseIcs(text: string, source: string): CalendarEvent[] {
  const lines = unfold(String(text).replace(/^\uFEFF/, '').split(/\r?\n/))
  const events: CalendarEvent[] = []
  let block: Array<{ name: string; params: string; value: string }> = []
  let inEvent = false

  const flush = (): void => {
    if (block.length === 0) return
    const properties = block
    block = []
    const first = (name: string): string | undefined =>
      properties.find((property) => property.name === name)?.value

    const title = unescape(first('SUMMARY') ?? '').trim() || '(untitled event)'
    const description = unescape(first('DESCRIPTION') ?? '').trim()
    const startRaw = first('DTSTART')
    if (!startRaw) return

    const startParam = properties.find((property) => property.name === 'DTSTART')?.params ?? ''
    const start = parseIcsDate(startRaw, startParam)
    const endRaw = first('DTEND')
    const endParam = properties.find((property) => property.name === 'DTEND')?.params ?? ''
    const end = endRaw ? parseIcsDate(endRaw, endParam) : { iso: null, allDay: start.allDay }
    const explicitUid = unescape(first('UID') ?? '').trim()
    const fingerprint = `${source}|${start.iso ?? startRaw}|${title}`
    const uid = explicitUid || createHash('sha1').update(fingerprint).digest('hex')

    events.push({
      id: `cal-${Date.now()}-${events.length}-${createHash('sha1').update(uid).digest('hex').slice(0, 8)}`,
      uid,
      title,
      description,
      startAt: start.iso,
      endAt: end.iso,
      allDay: start.allDay,
      source,
      createdAt: Date.now()
    })
  }

  for (const line of lines) {
    if (line.toUpperCase() === 'BEGIN:VEVENT') {
      block = []
      inEvent = true
      continue
    }
    if (line.toUpperCase() === 'END:VEVENT') {
      flush()
      inEvent = false
      continue
    }
    const property = splitProperty(line)
    if (property && inEvent && property.name !== 'BEGIN' && property.name !== 'END') {
      block.push(property)
    }
  }
  return events
}

export function pickIcs(): string | null {
  const chosen = dialog.showOpenDialogSync({
    title: 'Import local calendar (.ics)',
    filters: [
      { name: 'iCalendar', extensions: ['ics', 'ical', 'txt'] }
    ],
    properties: ['openFile']
  })
  return chosen?.[0] ?? null
}

export function importIcs(path: string): CalendarImportResult {
  if (!existsSync(path)) throw new Error(`Calendar file not found: ${path}`)
  const text = readFileSync(path, 'utf8')
  const source = path.split(/[\\/]/).pop() || path
  const events = parseIcs(text, source)
  const { imported, skipped } = store.importCalendarEvents(events)

  let remindersCreated = 0
  const now = Date.now()
  for (const event of events) {
    if (!event.startAt) continue
    const fireAt = Date.parse(event.startAt)
    if (!Number.isFinite(fireAt) || fireAt <= now) continue
    store.createReminder(event.title, event.startAt)
    remindersCreated += 1
  }

  return { source, total: events.length, imported, skipped, remindersCreated }
}
