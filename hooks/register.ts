import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MarkLevel } from '../types'

// nametag: marks an idle session's name in up to three steps. Each level has a delay and an
// emoji: after level 1's delay with no prompt and no turn the name becomes "💤 name", after level
// 2's "💤💤 name", after level 3's "💤💤💤 name" (via /rename). Options put the mark after the
// name, join it with a separator, or wrap it in brackets. At the end of the next turn the mark
// comes off. Interactive sessions only, and only sessions that have a name (/rename was used
// at least once, or the session was started with --name).
//
// No API returns the session's name, so it is read from the transcript: the newest
// {"type":"custom-title","customTitle":...} row. That row format is undocumented and may change.

type Engine = EngineInterface

export type Level = { ms: number; emoji: string }

const CHECK_MS = 60 * 1000
const FS_READ_MAX = 4 * 1024 * 1024 // $.fs.read refuses bigger files
const TITLE_ROW = '"type":"custom-title"'
const LEGACY = '💤' // the mark of earlier versions; always recognised
const DEFAULTS: readonly [number, string][] = [[10, '💤'], [180, '💤'], [720, '💤']]

const transcript = atom({ plugin: 'nametag', key: 'transcript' } as const, null)
// How many levels the name carries: 0 awake, null not read yet.
const level = atom({ plugin: 'nametag', key: 'level' } as const, null as MarkLevel)

let lastActivity = 0
let inTurn = false
let isBusy = false
let reached = 0 // levels applied (or found unneeded) during this idle spell
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

// The style of versions before 0.5: the emojis, a space, the name. Always recognised.
function legacy(st: Style): Style {
  return { levels: st.levels, atEnd: false, sep: '', open: '', close: '' }
}

// `plain` marked with the first `n` levels.
export function marked(plain: string, st: Style, n: number): string {
  const emojis = st.levels.slice(0, n).map(l => l.emoji).join('')
  if (emojis === '') return plain
  const mark = st.open + emojis + st.close
  const join = st.sep === '' ? ' ' : ` ${st.sep} `
  return st.atEnd ? plain + join + mark : mark + join + plain
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// `name` without a mark in style `st`, or null when it carries none. A mark is the brackets (if
// any) around a run of level emojis (or the legacy 💤), joined to the name by whitespace or by the
// separator between whitespace. A name that merely starts with an emoji, with no space after it,
// is left alone.
function strip(name: string, st: Style): string | null {
  const units = [...new Set([...st.levels.map(l => l.emoji), LEGACY])].sort((a, b) => b.length - a.length)
  const join = st.sep === '' ? /\s+/ : new RegExp(`\\s+${escape(st.sep)}\\s+`)
  if (!st.atEnd) {
    let i = 0
    if (st.open) { if (!name.startsWith(st.open)) return null; i = st.open.length }
    const run = i
    for (let hit = true; hit; ) {
      hit = false
      for (const u of units) if (name.startsWith(u, i)) { i += u.length; hit = true; break }
    }
    if (i === run) return null
    if (st.close) { if (!name.startsWith(st.close, i)) return null; i += st.close.length }
    const m = new RegExp(`^${join.source}`).exec(name.slice(i))
    return m ? name.slice(i + m[0].length) : null
  }
  let j = name.length
  if (st.close) { if (!name.endsWith(st.close)) return null; j -= st.close.length }
  const run = j
  for (let hit = true; hit; ) {
    hit = false
    for (const u of units) if (name.endsWith(u, j)) { j -= u.length; hit = true; break }
  }
  if (j === run) return null
  if (st.open) { if (!name.endsWith(st.open, j)) return null; j -= st.open.length }
  const m = new RegExp(`${join.source}$`).exec(name.slice(0, j))
  return m ? name.slice(0, j - m[0].length) : null
}

// `name` without its mark, in the configured style or the legacy one; `name` itself if unmarked.
export function unmarked(name: string, st: Style): string {
  return strip(name, st) ?? strip(name, legacy(st)) ?? name
}

export function isMarked(name: string, st: Style): boolean {
  return unmarked(name, st) !== name
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
  else {
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

// Marks the name with the first `n` levels. Returns false when the name couldn't be read, so the
// next tick tries again.
async function sleep($: Engine, st: Style, n: number): Promise<boolean> {
  const name = await currentName($)
  if (name === undefined) return false
  if (name === null || name.trim() === '') return true
  const plain = unmarked(name, st)
  if (plain === '') return true
  const want = marked(plain, st, n)
  if (want === name || (await rename($, want))) await update($, level, () => n)
  return true
}

async function wake($: Engine, st: Style): Promise<void> {
  if ((await read($, level)) === 0) return
  const name = await currentName($)
  if (name === undefined) return
  if (name !== null) {
    const plain = unmarked(name, st)
    if (plain !== name && (plain === '' || !(await rename($, plain)))) return
  }
  await update($, level, () => 0)
}

async function tick($: Engine, st: Style): Promise<void> {
  if (isBusy || inTurn) return
  const idle = (await $.clock.now()) - lastActivity
  const n = st.levels.filter(l => idle >= l.ms).length
  if (n <= reached) return
  isBusy = true
  try {
    if (await sleep($, st, n)) reached = n
  } finally {
    isBusy = false
  }
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
    await active($)
    inTurn = false
    if (st.levels.length) timer = $.clock.every(CHECK_MS, () => { void tick($, st) })
    return r
  })

  on('prompt.submit', async ($, e, next) => { await active($); return next(e) })
    .catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { inTurn = true; await active($) }
    return next(e)
  })
  // /rename waits while a turn holds the session, so the mark comes off once the turn is done
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    inTurn = false
    await active($)
    await wake($, st)
    return r
  })
}
