import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mark, TopicMemory } from '../types'

// nametag: tags a session's name with what it is doing. Two tags, each its own option.
//
// Idle mark (on by default): marks an idle session's name in up to three steps. Each level has a delay and an
// emoji: after level 1's delay with no prompt and no turn the name becomes "💤 name", after level
// 2's "💤💤 name", after level 3's "💤💤💤 name" (via /rename). Options put the mark after the
// name, join it with a separator, or wrap it in brackets. At the end of the next turn, or when the
// session starts again, the mark comes off. Interactive sessions only, and only sessions that have
// a name (/rename was used at least once, or the session was started with --name).
//
// Topic (option, off by default): a short label for what the session is working on, kept at the
// very end of the name ("Builder [billing-api]", asleep "💤 Builder [billing-api]"), awake or not.
// It comes from the paths the session's tools touch (a project folder that clearly leads) or, when
// they don't say, from one small-model call on the last few messages. The paths are checked at the
// end of every turn (that costs nothing), the model at most every 10 minutes; renamed only when it
// changes, and held back for a while after the person renames the session.
//
// The name is always built from the name the person gave the session, never parsed out of a name.
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

const RECORD_DAYS = 90 // records of sessions not renamed by the mod for this long are dropped

const WORK_MAX_MS = 24 * 60 * 60 * 1000 // a background task whose end was never seen stops counting after this
// Not 'waiting': that may be on a plan's approval, which waits for the person; an agent waiting on
// its own background work is covered by that work, tracked below like any other.
const AGENT_BUSY = new Set(['pending', 'running'])

const MIN_MS = 60 * 1000
const TOPIC_MIN_TURNS = 3 // turns since the last model check before another
const TOPIC_RATE_MS = 10 * MIN_MS // at most one model check this often; the path weight halves this often too
const TOPIC_MAX_WAIT_MS = 120 * MIN_MS // checks that find nothing double the wait, up to this
const TOPIC_SHARE = 0.6 // a project leads when it has this share of the path weight...
const TOPIC_MIN_WEIGHT = 5 // ...and at least this much of it
const TOPIC_MAX_LEN = 20
const TOPIC_MAX_WORDS = 2
// Tools whose path says where the work is: an edit says more than a read.
const PATH_TOOLS: Record<string, { field: string; weight: number; dir?: true }> = {
  Edit: { field: 'file_path', weight: 3 },
  Write: { field: 'file_path', weight: 3 },
  NotebookEdit: { field: 'notebook_path', weight: 3 },
  Read: { field: 'file_path', weight: 1 },
  Grep: { field: 'path', weight: 1, dir: true },
  Glob: { field: 'path', weight: 1, dir: true },
}

const transcript = atom({ plugin: 'nametag', key: 'transcript' } as const, null)
// The topic's bookkeeping between checks.
const topicMem = atom({ plugin: 'nametag', key: 'topic' } as const, null as TopicMemory | null)
// Background commands and workflows still running: task id -> when it started.
const work = atom({ plugin: 'nametag', key: 'work' } as const, null as Record<string, number> | null)
// A turn of the main conversation is running. In the session's state so a hot reload mid-turn keeps it.
const turning = atom({ plugin: 'nametag', key: 'inTurn' } as const, false as boolean | null)
// This session's record as last written, so another session writing the shared store can't lose it.
const live = atom({ plugin: 'nametag', key: 'record' } as const, null as { id: string; mark: Mark | null } | null)

let lastActivity = 0
let reached = 0 // levels applied (or found unneeded) during this idle spell
let sleeping: Promise<void> | undefined // the rename job in flight (see serial)
let wakePending = false // the last attempt to take the mark off must be tried again
let personRenames = 0 // the person's /renames seen so far
let personName = '' // the name the last of them gave
let scanAfter = 0
let interactive = false
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
export type Style = {
  levels: Level[]; atEnd: boolean; sep: string; open: string; close: string
  topic: boolean; topicSep: string; topicOpen: string; topicClose: string; freezeMs: number; topicModel: string
}

const BRACKETS: Record<string, [string, string]> = { '[]': ['[', ']'], '()': ['(', ')'], '{}': ['{', '}'], '<>': ['<', '>'] }

export function style(options: Record<string, unknown>): Style {
  const sep = typeof options.separator === 'string' ? options.separator.trim() : ''
  const pair = typeof options.brackets === 'string' ? BRACKETS[options.brackets.replace(/\s/g, '')] : undefined
  const hours = typeof options.topic_freeze_hours === 'number' && options.topic_freeze_hours >= 0 ? options.topic_freeze_hours : 4
  const tb = typeof options.topic_brackets === 'string' ? options.topic_brackets : '[]'
  const topicPair = BRACKETS[tb.replace(/\s/g, '')]
  const model = typeof options.topic_model === 'string' && options.topic_model.trim() !== '' ? options.topic_model.trim() : 'haiku'
  return {
    levels: levels(options), atEnd: options.position === 'end', sep, open: pair?.[0] ?? '', close: pair?.[1] ?? '',
    topic: options.topic === 'on',
    topicSep: typeof options.topic_separator === 'string' ? options.topic_separator.trim() : '',
    topicOpen: topicPair?.[0] ?? '', topicClose: topicPair?.[1] ?? '',
    freezeMs: hours * 60 * MIN_MS,
    topicModel: model,
  }
}

// `plain` marked with the first `n` levels.
export function marked(plain: string, st: Style, n: number): string {
  const emojis = st.levels.slice(0, n).map(l => l.emoji).join('')
  if (emojis === '') return plain
  const mark = st.open + emojis + st.close
  const join = st.sep === '' ? ' ' : ` ${st.sep} `
  return st.atEnd ? plain + join + mark : mark + join + plain
}

// Whether the person's name already says the topic, as a word or words of it ("alpha" in "Alpha
// work", not in "alphabet").
export function inName(base: string, topic: string): boolean {
  const words = (s: string) => `-${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}-`
  const t = words(topic)
  return t !== '--' && words(base).includes(t)
}

// The whole name: the person's name, the mark of the first `n` levels, the topic last.
export function build(plain: string, st: Style, n: number, topic: string | null): string {
  const named = marked(plain, st, n)
  if (!topic) return named
  const label = st.topicOpen + topic + st.topicClose
  return st.topicSep === '' ? `${named} ${label}` : `${named} ${st.topicSep} ${label}`
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

function asMark(v: unknown): Mark | null {
  const m = v as Partial<Mark> | undefined
  return m && typeof m.set === 'string' && typeof m.base === 'string' && typeof m.at === 'number' ? (m as Mark) : null
}

// The session's own record lives in its state while it runs; the store carries it across restarts.
async function record($: Engine, id: string): Promise<Mark | null> {
  const l = await read($, live)
  if (l && l.id === id) return l.mark
  return asMark(await $.store.get(recordKey(id)))
}

async function setRecord($: Engine, id: string, mark: Mark): Promise<void> {
  await update($, live, () => ({ id, mark }))
  await $.store.set(recordKey(id), mark)
}

async function dropRecord($: Engine, id: string): Promise<void> {
  await update($, live, () => ({ id, mark: null }))
  await $.store.delete(recordKey(id))
}

// Drops the records the mod hasn't touched for RECORD_DAYS (sessions ended and never resumed), and
// holds on topics that are over. This session's own record is kept.
async function prune($: Engine): Promise<void> {
  const now = await $.clock.now()
  const cutoff = now - RECORD_DAYS * 24 * 60 * 60 * 1000
  const own = recordKey(await $.session.id())
  for (const key of await $.store.keys()) {
    if (key === own) {
      // this session's own: kept, and its age starts over
      const mine = await record($, await $.session.id())
      if (mine) await setRecord($, await $.session.id(), { ...mine, at: now })
    } else if (key.startsWith('mark:')) {
      const v = asMark(await $.store.get(key))
      if (!v || v.at < cutoff) await $.store.delete(key)
    } else if (key.startsWith('freeze:')) {
      const until = await $.store.get(key)
      if (typeof until !== 'number' || until <= now) await $.store.delete(key)
    }
  }
}

// After the person renames the session, topics wait for `topic_freeze_hours`.
function freezeKey(id: string): string {
  return `freeze:${id}`
}

async function freeze($: Engine, st: Style): Promise<void> {
  if (!st.topic || st.freezeMs <= 0) return
  await $.store.set(freezeKey(await $.session.id()), (await $.clock.now()) + st.freezeMs)
}

async function frozen($: Engine): Promise<boolean> {
  const key = freezeKey(await $.session.id())
  const until = await $.store.get(key)
  if (until === undefined) return false
  if (typeof until === 'number' && until > (await $.clock.now())) return true
  await $.store.delete(key)
  return false
}

// ---- sleeping and waking ---------------------------------------------------------------------

// Sets the name to the person's name with the mark of `want.level` levels and the topic
// `want.topic` (each left as it is when not given). Returns 'retry' when it should be tried again
// later (the name couldn't be read, or the rename failed), and 'renamed' when the person renamed
// the session since the mod last did: their name stands, and topics wait for a while.
type Want = { level?: number; topic?: string | null }

async function render($: Engine, st: Style, want: Want): Promise<'done' | 'retry' | 'renamed'> {
  const seen = personRenames
  const name = await currentName($)
  if (name === undefined) return 'retry'
  if (name === null || name.trim() === '') return 'done'
  const id = await $.session.id()
  const mine = await record($, id)
  if (mine && mine.set !== name) {
    await dropRecord($, id)
    await freeze($, st)
    return 'renamed'
  }
  const base = mine ? mine.base : name
  const level = want.level ?? mine?.level ?? 0
  let topic = want.topic !== undefined ? want.topic : (mine?.topic ?? null)
  if (!st.topic || (topic && inName(base, topic))) topic = null
  const target = build(base, st, level, topic)
  if (target !== name && !(await rename($, target))) return 'retry'
  if (personRenames !== seen) {
    // The person's /rename ran while this one waited its turn in the command queue, and this one,
    // run after it, may have replaced their name: theirs stands.
    if (personName && (await currentName($)) !== personName) await rename($, personName)
    await dropRecord($, id)
    await freeze($, st)
    return 'renamed'
  }
  if (target === base) await dropRecord($, id)
  else await setRecord($, id, { set: target, base, at: await $.clock.now(), level, topic })
  return 'done'
}

// Marks the name with the first `n` levels. 'renamed' counts as activity: the person is here, and
// their new name is marked after the next idle spell.
function sleep($: Engine, st: Style, n: number): Promise<'done' | 'retry' | 'renamed'> {
  return render($, st, { level: n })
}

// Takes the mark off, if the name is still the one this mod set. A name changed since (by /rename)
// is the person's new name and stays. The topic stays. One that fails is tried again by the tick.
async function unmark($: Engine, st: Style): Promise<void> {
  wakePending = false
  const mine = await record($, await $.session.id())
  if (!mine) return
  if ((mine.level ?? 1) === 0) return // a topic only: nothing to take off (a record with no level is a mark)
  wakePending = (await render($, st, { level: 0 })) === 'retry'
}

// ---- work in the background ----------------------------------------------------------------

// A command, workflow or agent working in the background keeps the session from being idle. Agents
// (subagents, teammates) are in $.agent.list(). Background commands and workflows are not: they are
// noted when a tool call puts one in the background and dropped when the notice of its end arrives
// (its task id appears in that notice), when TaskStop stops it, or after WORK_MAX_MS. A Monitor is
// a watch, not work, and doesn't count.
export function startedTask(tool: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (tool === 'Bash' && typeof r.backgroundTaskId === 'string' && r.backgroundEndsWithFinalResponse !== true) return r.backgroundTaskId
  if (tool === 'Workflow' && typeof r.taskId === 'string' && (r.status === 'async_launched' || r.status === 'remote_launched')) return r.taskId
  return null
}

async function track($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  await update($, work, w => ({ ...(w ?? {}), [id]: now }))
}

async function untrack($: Engine, ended: (id: string) => boolean): Promise<void> {
  const w = await read($, work)
  if (!w) return
  const left = Object.fromEntries(Object.entries(w).filter(([id]) => !ended(id)))
  if (Object.keys(left).length !== Object.keys(w).length) await update($, work, () => left)
}

// Whether a notice names the task id as a whole word ("b1" is not in "b12").
export function mentions(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(text)
}

async function busy($: Engine): Promise<boolean> {
  const now = await $.clock.now()
  const w = (await read($, work)) ?? {}
  const stale = Object.entries(w).filter(([, at]) => now - at > WORK_MAX_MS).map(([id]) => id)
  if (stale.length) await untrack($, id => stale.includes(id))
  if (Object.keys(w).length > stale.length) return true
  try {
    return (await $.agent.list()).some(a => AGENT_BUSY.has(a.status))
  } catch {
    return false
  }
}

// Cheapest check first; the first that finds the session in use ends the tick: a rename or a turn
// running (in memory), no level due yet (the clock), work in the background (the session's state,
// then the agent list). Only then is the transcript read, to mark the name.
async function tick($: Engine, st: Style): Promise<void> {
  if (sleeping || (await read($, turning))) return
  if (wakePending) return void serial($, () => unmark($, st))
  const since = lastActivity
  const idle = (await $.clock.now()) - since
  const n = st.levels.filter(l => idle >= l.ms).length
  if (n <= reached) return
  // work in the background counts as activity: the idle time starts over
  if (await busy($)) return active($)
  await serial($, async () => {
    // activity during the rename resets `reached`; the turn's end then takes the mark off again
    const result = await sleep($, st, n)
    if (result === 'renamed') await active($)
    else if (result === 'done' && lastActivity === since) {
      reached = n
    }
  })
}

async function active($: Engine): Promise<void> {
  lastActivity = await $.clock.now()
  reached = 0
}

// ---- the topic ------------------------------------------------------------------------------

function fresh(): TopicMemory {
  return { turns: 0, lastCheck: 0, weights: {}, total: 0, decayedAt: 0, misses: 0 }
}

async function mem($: Engine): Promise<TopicMemory> {
  return (await read($, topicMem)) ?? fresh()
}

async function setMem($: Engine, f: (m: TopicMemory) => TopicMemory): Promise<void> {
  await update($, topicMem, m => f(m ?? fresh()))
}

// Runs `fn` after any rename in flight, as one: ticks skip and wake waits while it runs.
function serial($: Engine, fn: () => Promise<unknown>): Promise<void> {
  const prev = sleeping
  const p: Promise<void> = (async () => {
    await prev
    await fn()
  })()
    .catch(err => { $.ui.log(`nametag: ${err}`, { to: 'debug' }) })
    .finally(() => { if (sleeping === p) sleeping = undefined })
  sleeping = p
  return p
}

// The folders above a path, nearest first ('/a/b/f' -> '/a/b', '/a').
export function parentDirs(path: string): string[] {
  const out: string[] = []
  let p = path.replace(/\/+$/, '')
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/')) {
    p = p.slice(0, i)
    out.push(p)
  }
  return out
}

function baseName(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1)
}

// A folder's name as a topic: cleaned like the model's answer; a dot folder is none.
function folderTopic(name: string): string | null {
  return name.startsWith('.') ? null : cleanTopic(name, null, 'last')
}

const gitDirs = new Map<string, boolean>()
let workspace: { root: string; is: boolean } | undefined

async function hasGit($: Engine, dir: string): Promise<boolean> {
  let v = gitDirs.get(dir)
  if (v === undefined) {
    v = await $.fs.exists(`${dir}/.git`).catch(() => false)
    gitDirs.set(dir, v)
  }
  return v
}

// A root that holds projects of its own (a folder in it has .git): each folder in it is a project.
async function isWorkspace($: Engine, root: string): Promise<boolean> {
  if (workspace?.root === root) return workspace.is
  let is = false
  try {
    const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir' && !d.name.startsWith('.')).slice(0, 100)
    for (const d of dirs) if (await hasGit($, `${root}/${d.name}`)) { is = true; break }
  } catch {}
  workspace = { root, is }
  return is
}

// The project a path belongs to, or null. Under the session's root: in a workspace root, the folder
// in it; else a repository of its own inside the root (the root's own project says nothing new).
// Elsewhere: the nearest repository above it.
async function projectOf($: Engine, path: string, isDir: boolean): Promise<string | null> {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!p.startsWith('/')) return null
  const root = (await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '')
  const dirs = isDir ? [p, ...parentDirs(p)] : parentDirs(p)
  if (p === root || p.startsWith(`${root}/`)) {
    const rest = p.slice(root.length + 1)
    if (await isWorkspace($, root)) return rest !== '' && (rest.includes('/') || isDir) ? folderTopic(rest.split('/')[0]!) : null
    for (const dir of dirs) {
      if (dir.length <= root.length) break
      if (await hasGit($, dir)) return folderTopic(baseName(dir))
    }
    return null
  }
  for (const dir of dirs.slice(0, 12)) if (await hasGit($, dir)) return folderTopic(baseName(dir))
  return null
}

async function notePath($: Engine, path: string, weight: number, isDir: boolean): Promise<void> {
  const project = await projectOf($, path, isDir)
  const now = await $.clock.now()
  await setMem($, m => ({
    ...(m = decay(m, now)), // the old weight halves before the new is added
    total: m.total + weight,
    weights: project ? { ...m.weights, [project]: (m.weights[project] ?? 0) + weight } : m.weights,
  }))
}

// The project that clearly leads the path weight, or null.
export function leader(weights: Record<string, number>, total: number): string | null {
  let best: string | null = null
  let most = 0
  for (const [k, v] of Object.entries(weights)) if (v > most) { best = k; most = v }
  return best !== null && most >= TOPIC_MIN_WEIGHT && most >= TOPIC_SHARE * total ? best : null
}

const NOISE = /<(command-name|command-message|local-command|task-notification|system-reminder)|^Session renamed to/

// The last few prompts and replies, one line each, oldest first: 6 of the person's, 2 of Claude's.
export function recentLines(messages: readonly { role: string; text: string }[]): string[] {
  const out: string[] = []
  let users = 0
  let claudes = 0
  for (let i = messages.length - 1; i >= 0 && users + claudes < 8; i--) {
    const m = messages[i]!
    const t = m.text.trim()
    if (!t || NOISE.test(t)) continue
    if (m.role === 'user' && users < 6) { users++; out.push(`User: ${t.replace(/\s+/g, ' ').slice(0, 300)}`) }
    else if (m.role === 'assistant' && claudes < 2) { claudes++; out.push(`Claude: ${t.replace(/\s+/g, ' ').slice(0, 300)}`) }
  }
  return out.reverse()
}

// The model's answer as a label: one line, letters, digits, '.', '_' and '-', two words at most
// (`keep` says which two: a folder like "cc-mod-billing-api" says most in its last ones), and
// TOPIC_MAX_LEN characters at most. SAME keeps `current`. Null when nothing usable is left.
export function cleanTopic(text: string, current: string | null, keep: 'first' | 'last' = 'first'): string | null {
  const line = (text.trim().split('\n')[0] ?? '').trim().replace(/^["'`*]+|["'`*.]+$/g, '')
  if (/^same$/i.test(line)) return current
  const slug = line
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const words = slug.split(/[-_]+/).filter(Boolean)
  const two = (keep === 'last' ? words.slice(-TOPIC_MAX_WORDS) : words.slice(0, TOPIC_MAX_WORDS)).join('-')
  const label = two.slice(0, TOPIC_MAX_LEN).replace(/[-._]+$/, '')
  return label === '' ? null : label
}

const TOPIC_SYSTEM = 'You label work sessions. Reply with the label only.'

async function askModel($: Engine, st: Style, current: string | null): Promise<string | null> {
  const lines = recentLines(await $.session.messages())
  if (!lines.length) return null
  const prompt = [
    `Current label: ${current ?? 'none'}`,
    '',
    'Recent messages:',
    ...lines,
    '',
    'Give one short label for what this session is working on now: one word, or two joined by a',
    'hyphen, like "billing-api" or "docs-site". If the current label still fits, reply SAME.',
  ].join('\n')
  let r: Awaited<ReturnType<Engine['model']['complete']>>
  try {
    r = await $.model.complete({ model: st.topicModel, system: TOPIC_SYSTEM, prompt, maxTokens: 20, timeoutMs: 30000 })
  } catch (err) {
    $.ui.log(`nametag: topic: ${err}`, { to: 'debug' }) // refused (an unknown model, say): a miss
    return null
  }
  if (!r.isAnswered) {
    $.ui.log(`nametag: topic: ${'reason' in r ? String(r.reason) : 'no answer'}`, { to: 'debug' })
    return null
  }
  return cleanTopic(r.text, current)
}

// The path weight halves every TOPIC_RATE_MS, so the paths of the last half hour or so decide.
export function decay(m: TopicMemory, now: number): TopicMemory {
  if (!m.decayedAt) return { ...m, decayedAt: now } // 0: not started yet
  const k = Math.floor((now - m.decayedAt) / TOPIC_RATE_MS)
  if (k <= 0) return m
  const f = k >= 20 ? 0 : 0.5 ** k
  const weights: Record<string, number> = {}
  for (const [p, v] of Object.entries(m.weights)) if (v * f >= 0.5) weights[p] = v * f
  return { ...m, weights, total: m.total * f, decayedAt: m.decayedAt + k * TOPIC_RATE_MS }
}

// The person's name under the mod's, and the topic now on it, read in step with the renames. A
// name the mod didn't set is the person's (renamed from the app, say), which stands alone while
// topics wait. Null: unnamed, unreadable, or just renamed by the person.
async function named($: Engine, st: Style, id: string): Promise<{ base: string; current: string | null } | null> {
  let out: { base: string; current: string | null } | null = null
  await serial($, async () => {
    const name = await currentName($)
    if (!name || name.trim() === '') return
    const mine = await record($, id)
    if (mine && mine.set !== name) {
      await dropRecord($, id)
      await freeze($, st)
      return
    }
    out = { base: mine ? mine.base : name, current: mine?.topic ?? null }
  })
  return out
}

// Puts `topic` on the name, unless the person renamed the session since `seen` (a model call can
// take a while) or topics are held. Turn's end: the session is awake, so no mark.
function setTopic($: Engine, st: Style, topic: string, seen: number): Promise<void> {
  return serial($, async () => {
    if (personRenames !== seen || (await frozen($))) return
    await render($, st, { topic, level: 0 })
  })
}

// At the end of each turn of the main conversation, cheapest test first. The paths first: when one
// project leads them, it is the topic, with no model call. Otherwise the model, after 3 turns and
// 10 minutes since its last check; a check that found nothing (the model failed, or only gave the
// name back) doubles the wait, up to 2 hours.
async function topicTurn($: Engine, st: Style): Promise<void> {
  if (!st.topic || !interactive) return
  const seen = personRenames
  const now = await $.clock.now()
  await setMem($, m => ({ ...decay(m, now), turns: m.turns + 1 }))
  if (await frozen($)) return
  const m = await mem($)
  const id = await $.session.id()
  const project = leader(m.weights, m.total)

  if (project !== null) {
    if (((await record($, id))?.topic ?? null) === project) return // the record alone: no name read
    const n = await named($, st, id)
    if (!n || n.current === project || inName(n.base, project)) return
    await setMem($, x => ({ ...x, misses: 0 }))
    await setTopic($, st, project, seen)
    return
  }

  if (m.turns < TOPIC_MIN_TURNS) return
  const since = m.lastCheck === 0 ? Infinity : now - m.lastCheck // 0: never checked
  if (since < Math.min(TOPIC_RATE_MS * 2 ** m.misses, TOPIC_MAX_WAIT_MS)) return
  await setMem($, x => ({ ...x, turns: 0, lastCheck: now }))
  const n = await named($, st, id)
  if (!n) return // no model call
  let topic = await askModel($, st, n.current)
  if (topic && inName(n.base, topic)) topic = null
  if (!topic) {
    await setMem($, x => ({ ...x, misses: x.misses + 1 }))
    return
  }
  await setMem($, x => ({ ...x, misses: 0 }))
  if (topic !== n.current) await setTopic($, st, topic, seen)
}

// ---- hooks ---------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const st = style(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    interactive = e.isInteractive
    if (!e.isInteractive) return r
    await prune($).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
    await active($)
    // A session that starts is in use: a mark it ended with (restart, resume, reload) comes off
    // now. Not awaited: a rename waits for a running turn; ticks skip and wake waits while it runs.
    void serial($, () => unmark($, st))
    if (st.levels.length) {
      timer = $.clock.every(CHECK_MS, () => {
        tick($, st).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      })
    }
    return r
  })

  // A prompt from another plugin starts a turn of its own, which counts below. A background task's
  // notice of its end names its task id.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') await active($)
    if (e.origin?.kind === 'task-notification') await untrack($, id => mentions(e.text, id))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The person renames the session: their name stands alone, and topics wait for a while. The
  // record goes once the name is no longer the mod's (the rename went through). Not awaited: it
  // waits for any rename of the mod's in flight, which may wait for this command.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'rename' || e.origin?.kind === 'plugin') return next(e)
    personRenames++
    personName = e.args.trim()
    await active($) // the person is here: their new name is marked after a full idle spell
    const r = await next(e)
    void serial($, async () => {
      const id = await $.session.id()
      const mine = await record($, id)
      const name = await currentName($)
      if (mine && name !== undefined && name !== mine.set) await dropRecord($, id)
      await freeze($, st)
    })
    return r
  }).catch(($, e, next) => next(e))

  // Work put in the background, and the paths the work touches, in any agent's loop.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      const pathTool = st.topic ? PATH_TOOLS[e.tool] : undefined
      const path = pathTool ? (e as Record<string, unknown>)[pathTool.field] : undefined
      if (pathTool && typeof path === 'string') await notePath($, path, pathTool.weight, pathTool.dir === true)
      if (!('deny' in r && r.deny !== undefined) && !r.isError) {
        const id = startedTask(e.tool, r.result)
        if (id) await track($, id)
        if (e.tool === 'TaskStop') {
          const stopped = (r.result as { task_id?: unknown } | undefined)?.task_id
          if (typeof stopped === 'string') await untrack($, id => id === stopped)
        }
      }
    } catch (err) {
      $.ui.log(`nametag: ${err}`, { to: 'debug' })
    }
    return r
  }).catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { await update($, turning, () => true); await active($) }
    return next(e)
  })
  // /rename waits while a turn holds the session, so the mark comes off once the turn is done.
  // Any session clears a mark, headless ones too; only interactive ones get marked.
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (!e.agentId) {
        await update($, turning, () => false)
        await active($)
        // Neither awaited: the rename waits for its turn in the queue, and the topic may ask the model.
        void serial($, () => unmark($, st))
        topicTurn($, st).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      }
    }
  })
}
