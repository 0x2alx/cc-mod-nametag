import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mark } from '../types'

// nametag: after `idle_minutes` with no prompt and no turn, put `prefix` in front of the session's
// name (via /rename); at the end of the next turn, take it off again. Interactive sessions only,
// and only sessions that have a name (/rename was used at least once).
//
// No API returns the session's name, so it is read from the transcript: the newest
// {"type":"custom-title","customTitle":...} row. That row format is undocumented and may change.

type Engine = EngineInterface

const CHECK_MS = 60 * 1000
const FS_READ_MAX = 4 * 1024 * 1024 // $.fs.read refuses bigger files
const TITLE_ROW = '"type":"custom-title"'

const transcript = atom({ plugin: 'nametag', key: 'transcript' } as const, null)
const mark = atom({ plugin: 'nametag', key: 'mark' } as const, 'unknown' as Mark)

let lastActivity = 0
let inTurn = false
let isBusy = false
let isSleptThisIdle = false
let timer: { cancel(): void } | undefined

// ---- the prefix ----------------------------------------------------------------------------

// The visible part of the prefix ("💤💤💤" for "💤💤💤 ").
function core(prefix: string): string {
  return prefix.trim()
}

// When the prefix is one symbol repeated ("💤💤💤"), that symbol: any run of it counts as the mark,
// so a name marked with an older or shorter prefix ("💤 ") still wakes cleanly.
function unit(prefix: string): string | null {
  const chars = [...core(prefix)]
  const first = chars[0]
  return first !== undefined && chars.every(c => c === first) ? first : null
}

export function isMarked(name: string, prefix: string): boolean {
  const c = core(prefix)
  const u = unit(prefix)
  return c !== '' && (name.startsWith(c) || (u !== null && name.startsWith(u)))
}

export function unmarked(name: string, prefix: string): string {
  const c = core(prefix)
  const u = unit(prefix)
  let out = name
  for (let changed = c !== ''; changed; ) {
    changed = false
    if (out.startsWith(c)) { out = out.slice(c.length).trimStart(); changed = true }
    else if (u !== null && out.startsWith(u)) { out = out.slice(u.length).trimStart(); changed = true }
  }
  return out
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

// Puts the prefix on. Returns false when the name couldn't be read, so the next tick tries again.
async function sleep($: Engine, prefix: string): Promise<boolean> {
  const name = await currentName($)
  if (name === undefined) return false
  if (name === null || name.trim() === '') return true
  if (isMarked(name, prefix)) { await update($, mark, () => 'asleep'); return true }
  if (await rename($, prefix + name)) await update($, mark, () => 'asleep')
  return true
}

async function wake($: Engine, prefix: string): Promise<void> {
  if ((await read($, mark)) === 'awake') return
  const name = await currentName($)
  if (name === undefined) return
  if (name !== null && isMarked(name, prefix)) {
    const plain = unmarked(name, prefix)
    if (plain === '' || !(await rename($, plain))) return
  }
  await update($, mark, () => 'awake')
}

async function tick($: Engine, idleMs: number, prefix: string): Promise<void> {
  if (isBusy || inTurn || isSleptThisIdle) return
  if ((await $.clock.now()) - lastActivity < idleMs) return
  isBusy = true
  try {
    isSleptThisIdle = await sleep($, prefix)
  } finally {
    isBusy = false
  }
}

async function active($: Engine): Promise<void> {
  lastActivity = await $.clock.now()
  isSleptThisIdle = false
}

// ---- hooks ---------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const minutes = typeof options.idle_minutes === 'number' && options.idle_minutes > 0 ? options.idle_minutes : 10
  const idleMs = minutes * 60 * 1000
  const prefix = typeof options.prefix === 'string' && options.prefix.trim() !== '' ? options.prefix : '💤💤💤 '

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    if (!e.isInteractive) return r
    await active($)
    inTurn = false
    timer = $.clock.every(CHECK_MS, () => { void tick($, idleMs, prefix) })
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
    await wake($, prefix)
    return r
  })
}
