import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mark } from '../types'

// nametag: marks an idle session's name in up to three steps. Each level has a delay and an
// emoji: after level 1's delay with no prompt and no turn the name becomes "💤 name", after level
// 2's "💤💤 name", after level 3's "💤💤💤 name" (via /rename). Options put the mark after the
// name, join it with a separator, or wrap it in brackets. At the end of the next turn the mark
// comes off. Interactive sessions only, and only sessions that have a name (/rename was used at
// least once, or the session was started with --name).
//
// The mark is always built from the name the person gave the session, never parsed out of a name.
// The transcript doesn't say who set a name, so the mod keeps a record per session in its store:
// the name it set and the person's name under it. The current name is the person's own unless it
// is exactly the one in the record.
//
// No API returns the session's name, so it is read from the transcript: the newest
// {"type":"custom-title","customTitle":...} row. That row format is undocumented and may change.

type Engine = EngineInterface

export type Level = { ms: number; emoji: string }

const CHECK_MS = 60 * 1000
const FS_READ_MAX = 4 * 1024 * 1024 // $.fs.read refuses bigger files
const TITLE_ROW = '"type":"custom-title"'
const DEFAULTS: readonly [number, string][] = [[10, '💤'], [180, '💤'], [720, '💤']]

const SCAN_RETRY_MS = 10 * 60 * 1000 // a transcript not found: search every project folder again after this

const RECORD_DAYS = 30 // records of sessions never woken again are dropped after this

const transcript = atom({ plugin: 'nametag', key: 'transcript' } as const, null)
// 0.5 and earlier: how many levels the name carried. Read once, to wake a name marked before the
// upgrade; remove in a later version.
const oldLevel = atom({ plugin: 'nametag', key: 'level' } as const, null as number | null)

let lastActivity = 0
let inTurn = false
let reached = 0 // levels applied (or found unneeded) during this idle spell
let sleeping: Promise<void> | undefined // a tick's (or the upgrade's) rename in flight; wake waits for it
let scanAfter = 0
let timer: { cancel(): void } | undefined

// ---- the levels and the mark ---------------------------------------------------------------

// The configured levels, earliest first. A level with an empty emoji is off.
export function levels(options: Record<string, unknown>): Level[] {
  const out: Level[] = []
  DEFAULTS.forEach(([minutes, emoji], i) => {
    const m = options[`level${i + 1}_minutes`]
    const e = options[`level${i + 1}_emoji`]
    const mins = typeof m === 'number' && m > 0 ? m : minutes
    const em = typeof e === 'string' ? e.trim() : emoji
    if (em !== '') out.push({ ms: mins * 60 * 1000, emoji: em })
  })
  return out.sort((a, b) => a.ms - b.ms)
}

// How the mark sits next to the name: before it (default) or after it, joined by a space or by
// " <separator> ", the emojis optionally in brackets.
export type Style = { levels: Level[]; atEnd: boolean; sep: string; open: string; close: string }

const BRACKETS: Record<string, [string, string]> = { '[]': ['[', ']'], '()': ['(', ')'], '{}': ['{', '}'], '<>': ['<', '>'] }

export function style(options: Record<string, unknown>): Style {
  const sep = typeof options.separator === 'string' ? options.separator.trim() : ''
  const pair = typeof options.brackets === 'string' ? BRACKETS[options.brackets.replace(/\s/g, '')] : undefined
  return { levels: levels(options), atEnd: options.position === 'end', sep, open: pair?.[0] ?? '', close: pair?.[1] ?? '' }
}

// `plain` marked with the first `n` levels.
export function marked(plain: string, st: Style, n: number): string {
  const emojis = st.levels.slice(0, n).map(l => l.emoji).join('')
  if (emojis === '') return plain
  const mark = st.open + emojis + st.close
  const join = st.sep === '' ? ' ' : ` ${st.sep} `
  return st.atEnd ? plain + join + mark : mark + join + plain
}

// ---- reading the name ----------------------------------------------------------------------

// The newest custom-title row among `text`'s lines, or null.
export function newestTitle(text: string): string | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('custom-title')) continue
    try {
      const row = JSON.parse(line)
      if (row?.type === 'custom-title' && typeof row.customTitle === 'string') return row.customTitle
    } catch {}
  }
  return null
}

// Claude Code's folder name for a project: every character other than a letter or digit as '-'.
export function projectFolder(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

// Claude Code's config folder: $CLAUDE_CONFIG_DIR, else ~/.claude.
async function configDir($: Engine): Promise<string | null> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return config.replace(/[\\/]+$/, '')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : null
}

// This session's transcript, <config>/projects/<project folder>/<session id>.jsonl. The session id
// is unique, so the file is found by its name: first in the folder Claude Code names after the
// project root, else in any project folder (long paths get a shortened folder name). The path
// found is kept for the session.
//
// Hook events that carry transcript_path (classic.Stop and the like) would be simpler, but Claude
// Code's built-in security plugin passes those events on past user-installed mods.
async function transcriptPath($: Engine): Promise<string | null> {
  const id = await $.session.id()
  const known = await read($, transcript)
  if (known && known.replace(/\\/g, '/').endsWith(`/${id}.jsonl`)) return known
  const config = await configDir($)
  if (!config) return null
  const projects = `${config}/projects`
  const file = `${id}.jsonl`
  const guess = `${projects}/${projectFolder(await $.session.root())}/${file}`
  let found: string | null = null
  if (await $.fs.exists(guess)) found = guess
  else if ((await $.clock.now()) >= scanAfter) {
    scanAfter = (await $.clock.now()) + SCAN_RETRY_MS
    try {
      for (const dir of await $.fs.list(projects)) {
        if (dir.kind !== 'dir') continue
        const candidate = `${projects}/${dir.name}/${file}`
        if (await $.fs.exists(candidate)) { found = candidate; break }
      }
    } catch {}
  }
  if (found) await update($, transcript, () => found)
  return found
}

// The session's name as /rename last set it: a string, null when the session was never named, or
// undefined when the transcript can't be found or read (try again later).
async function currentName($: Engine): Promise<string | null | undefined> {
  const path = await transcriptPath($)
  if (!path) return undefined
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file') return undefined
    if (st.size <= FS_READ_MAX) return newestTitle(await $.fs.read(path))
  } catch {
    return undefined
  }
  // Too big for $.fs.read: let the system's search tool pick the rows.
  for (const argv of [['grep', '-a', '-F', TITLE_ROW, path], ['findstr', '/L', '/C:custom-title', path]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 20000 })
      if (r.exitCode === 0 || r.exitCode === 1) return newestTitle(r.stdout)
    } catch {}
  }
  return undefined
}

// ---- renaming ------------------------------------------------------------------------------

async function rename($: Engine, name: string): Promise<boolean> {
  try {
    await $.command.run({ command: 'rename', args: name })
    return true
  } catch (err) {
    $.ui.log(`nametag: rename failed: ${err}`, { to: 'debug' })
    return false
  }
}

// ---- the record -----------------------------------------------------------------------------

function recordKey(id: string): string {
  return `mark:${id}`
}

async function record($: Engine, id: string): Promise<Mark | null> {
  const v = (await $.store.get(recordKey(id))) as Partial<Mark> | undefined
  return v && typeof v.set === 'string' && typeof v.base === 'string' && typeof v.at === 'number' ? (v as Mark) : null
}

// Drops the records of sessions not marked for RECORD_DAYS (ended while asleep, never resumed).
async function prune($: Engine): Promise<void> {
  const cutoff = (await $.clock.now()) - RECORD_DAYS * 24 * 60 * 60 * 1000
  for (const key of await $.store.keys()) {
    if (!key.startsWith('mark:')) continue
    const v = (await $.store.get(key)) as Partial<Mark> | undefined
    if (!v || typeof v.at !== 'number' || v.at < cutoff) await $.store.delete(key)
  }
}

// ---- sleeping and waking ---------------------------------------------------------------------

// Marks the name with the first `n` levels, built from the person's name. Returns 'retry' when it
// should be tried again on the next tick (the name couldn't be read, or the rename failed), and
// 'renamed' when the person renamed the session while it was marked: they are here, so that counts
// as activity, and their new name is marked after the next idle spell.
async function sleep($: Engine, st: Style, n: number): Promise<'done' | 'retry' | 'renamed'> {
  const name = await currentName($)
  if (name === undefined) return 'retry'
  if (name === null || name.trim() === '') return 'done'
  const id = await $.session.id()
  const mine = await record($, id)
  if (mine && mine.set !== name) {
    await $.store.delete(recordKey(id))
    return 'renamed'
  }
  const legacy = !mine && ((await read($, oldLevel)) ?? 0) > 0
  const base = legacy ? unmark05(name) : mine ? mine.base : name
  const want = marked(base, st, n)
  if (want !== name && !(await rename($, want))) return 'retry'
  await $.store.set(recordKey(id), { set: want, base, at: await $.clock.now() } satisfies Mark)
  if (legacy) await update($, oldLevel, () => null)
  return 'done'
}

// Puts the person's name back, if the name is still the one this mod set. A name changed since
// (by /rename) is the person's new name and stays.
async function wake($: Engine): Promise<void> {
  await sleeping
  const id = await $.session.id()
  const mine = await record($, id)
  if (!mine) return upgrade($)
  const name = await currentName($)
  if (name === undefined) return
  if (name === mine.set && !(await rename($, mine.base))) return
  await $.store.delete(recordKey(id))
}

// 0.5 and earlier kept no record and marked the front of the name: a run of 💤, a space, the name.
export function unmark05(name: string): string {
  const m = /^(?:💤)+\s+/u.exec(name)
  return m && name.length > m[0].length ? name.slice(m[0].length) : name
}

// Upgrading from 0.5 (its state says the name carries its mark): the name loses that mark once.
// Runs when the new code loads, so it is done before a restart drops the session's state. If 0.6.0
// already marked the name on top, its record's base still carries the 0.5 mark: cleaned there, and
// the next wake puts back the clean name. Tried again at each wake until it is done.
async function upgrade($: Engine): Promise<void> {
  const level = await read($, oldLevel)
  if (level === null || level === undefined) return
  if (level > 0) {
    const id = await $.session.id()
    const mine = await record($, id)
    if (mine) {
      const base = unmark05(mine.base)
      if (base !== mine.base) await $.store.set(recordKey(id), { ...mine, base } satisfies Mark)
    } else {
      const name = await currentName($)
      if (name === undefined) return
      const plain = name === null ? name : unmark05(name)
      if (plain !== name && plain !== null && !(await rename($, plain))) return
    }
  }
  await update($, oldLevel, () => null)
}

async function tick($: Engine, st: Style): Promise<void> {
  if (sleeping || inTurn) return
  const since = lastActivity
  const idle = (await $.clock.now()) - since
  const n = st.levels.filter(l => idle >= l.ms).length
  if (n <= reached) return
  sleeping = (async () => {
    // activity during the rename resets `reached`; the turn's end then takes the mark off again
    const result = await sleep($, st, n)
    if (result === 'renamed') await active($)
    else if (result === 'done' && lastActivity === since) reached = n
  })()
    .catch(err => { $.ui.log(`nametag: ${err}`, { to: 'debug' }) })
    .finally(() => { sleeping = undefined })
  await sleeping
}

async function active($: Engine): Promise<void> {
  lastActivity = await $.clock.now()
  reached = 0
}

// ---- hooks ---------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const st = style(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    if (!e.isInteractive) return r
    await prune($).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
    await active($)
    inTurn = false
    // not awaited: a rename waits for a running turn; ticks skip and wake waits while it runs
    const up: Promise<void> = upgrade($)
      .catch(err => { $.ui.log(`nametag: ${err}`, { to: 'debug' }) })
      .finally(() => { if (sleeping === up) sleeping = undefined })
    sleeping = up
    if (st.levels.length) {
      timer = $.clock.every(CHECK_MS, () => {
        tick($, st).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      })
    }
    return r
  })

  // A prompt from another plugin starts a turn of its own, which counts below.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') await active($)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { inTurn = true; await active($) }
    return next(e)
  })
  // /rename waits while a turn holds the session, so the mark comes off once the turn is done.
  // Any session clears a mark, headless ones too; only interactive ones get marked.
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (!e.agentId) {
        inTurn = false
        await active($)
        await wake($).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      }
    }
  })
}
