import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MarkLevel } from '../types'

// nametag: marks an idle session's name in up to three steps. Each level has a delay and an
// emoji: after level 1's delay with no prompt and no turn the name becomes "💤 name", after level
// 2's "💤💤 name", after level 3's "💤💤💤 name" (via /rename). At the end of the next turn the
// mark comes off. Interactive sessions only, and only sessions that have a name (/rename was used
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

// The mark for the first `n` levels: their emojis side by side, then a space.
export function markFor(lv: readonly Level[], n: number): string {
  const s = lv.slice(0, n).map(l => l.emoji).join('')
  return s === '' ? '' : `${s} `
}

// `name` without its mark: a leading run of level emojis (or the legacy 💤) followed by a space.
// A name that merely starts with one of those emojis, with no space after the run, is left as is.
export function unmarked(name: string, lv: readonly Level[]): string {
  const units = [...new Set([...lv.map(l => l.emoji), LEGACY])].sort((a, b) => b.length - a.length)
  let i = 0
  for (let hit = true; hit; ) {
    hit = false
    for (const u of units) if (name.startsWith(u, i)) { i += u.length; hit = true; break }
  }
  if (i === 0 || !/^\s/.test(name.slice(i))) return name
  return name.slice(i).trimStart()
}

export function isMarked(name: string, lv: readonly Level[]): boolean {
  return unmarked(name, lv) !== name
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
async function sleep($: Engine, lv: readonly Level[], n: number): Promise<boolean> {
  const name = await currentName($)
  if (name === undefined) return false
  if (name === null || name.trim() === '') return true
  const plain = unmarked(name, lv)
  if (plain === '') return true
  const want = markFor(lv, n) + plain
  if (want === name || (await rename($, want))) await update($, level, () => n)
  return true
}

async function wake($: Engine, lv: readonly Level[]): Promise<void> {
  if ((await read($, level)) === 0) return
  const name = await currentName($)
  if (name === undefined) return
  if (name !== null) {
    const plain = unmarked(name, lv)
    if (plain !== name && (plain === '' || !(await rename($, plain)))) return
  }
  await update($, level, () => 0)
}

async function tick($: Engine, lv: readonly Level[]): Promise<void> {
  if (isBusy || inTurn) return
  const idle = (await $.clock.now()) - lastActivity
  const n = lv.filter(l => idle >= l.ms).length
  if (n <= reached) return
  isBusy = true
  try {
    if (await sleep($, lv, n)) reached = n
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
  const lv = levels(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    if (!e.isInteractive) return r
    await active($)
    inTurn = false
    if (lv.length) timer = $.clock.every(CHECK_MS, () => { void tick($, lv) })
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
    await wake($, lv)
    return r
  })
}
