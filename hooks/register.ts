import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// nametag: tags a session's name with what it is doing. Two tags, each its own option.
//
// Idle mark (on by default): marks an idle session's name in up to three steps. Each level has a
// delay and an emoji: after level 1's delay with no activity the name becomes "💤 name", after level
// 2's "💤💤 name", after level 3's "💤💤💤 name" (via /rename). Options put the mark after the
// name, join it with a separator, or wrap it in brackets. Every check sets exactly the levels the
// time since the last activity calls for; at the end of the next turn the mark comes off.
// Interactive sessions only, and only sessions that have a name (/rename was used at least once,
// or the session was started with --name).
//
// Topic (option, off by default): a short label for what the session is working on, kept at the
// very end of the name ("Builder [billing]", asleep "💤 Builder [billing]"), awake or not; one
// word by default, two with `topic_words: 2`.
// It comes from the paths of the session's last tool calls (a project folder that clearly leads)
// or, when they don't say, from one small-model call on the last few messages. Checked when the
// session starts and at the end of every turn; the model at most every 10 minutes. `/topic off`
// turns topics off for this session, `/topic on` back on.
//
// Nothing is kept between runs but the time of each session's last model check. Everything else is
// worked out when it is needed, from the session as it is then:
// - the name, read from the transcript (no API returns it): the newest
//   {"type":"custom-title","customTitle":...} row, a format that is undocumented and may change;
// - the person's name under the mark and topic: the name with the mark and topic as this mod builds
//   them taken off (the transcript doesn't say who set a name, so it can't be looked up);
// - the last activity: the newest timestamped prompt, reply or tool result in the transcript, kept
//   up to date while the session runs by its prompts and turns;
// - work in the background: the session's agents, and the background commands and workflows the
//   conversation started that it has no end notice for;
// - the topic: the paths of the conversation's last tool calls, or its last messages;
// - /topic off or on: the last such command in the transcript.

type Engine = EngineInterface

export type Level = { ms: number; emoji: string }

const CHECK_MS = 60 * 1000
const FS_READ_MAX = 4 * 1024 * 1024 // $.fs.read refuses bigger files
const TAIL_BYTES = 512 * 1024 // a big transcript is read from its last this many bytes
const TITLE_ROW = '"type":"custom-title"'
const TOPIC_ROW = '<command-name>/topic</command-name>'
const DEFAULTS: readonly [number, string][] = [[10, '💤'], [180, '💤'], [720, '💤']]

const SCAN_RETRY_MS = 10 * 60 * 1000 // a transcript not found: search every project folder again after this
const KEEP_DAYS = 90 // a session's last model check is forgotten after this long

const WORK_MAX_MS = 24 * 60 * 60 * 1000 // a background task seen starting whose end was never seen stops counting after this
// Not 'waiting': that may be on a plan's approval, which waits for the person; an agent waiting on
// its own background work is covered by that work.
const AGENT_BUSY = new Set(['pending', 'running'])

const MIN_MS = 60 * 1000
const TOPIC_RATE_MS = 10 * MIN_MS // at most one model check this often
const PATH_WINDOW = 30 // the session's last this many path tool calls decide the project
const TOPIC_MIN_PROMPTS = 3 // the model is asked only once the person has written this many prompts
const CONTEXT_PROMPTS = 10 // the model sees up to this many of the person's last prompts...
const CONTEXT_REPLIES = 4 // ...and of Claude's last replies...
const CONTEXT_CHARS = 600 // ...each cut to this many characters
const TOPIC_MAX_WAIT_MS = 120 * MIN_MS // checks that find nothing double the wait, up to this
const TOPIC_SHARE = 0.6 // a project leads when it has this share of the path weight...
const TOPIC_MIN_WEIGHT = 5 // ...and at least this much of it
const TOPIC_MAX_LEN = 20
const TOPIC_MAX_WORDS = 2 // the most `topic_words` allows
// Tools whose path says where the work is: an edit says more than a read.
const PATH_TOOLS: Record<string, { field: string; weight: number; dir?: true }> = {
  Edit: { field: 'file_path', weight: 3 },
  Write: { field: 'file_path', weight: 3 },
  NotebookEdit: { field: 'notebook_path', weight: 3 },
  Read: { field: 'file_path', weight: 1 },
  Grep: { field: 'path', weight: 1, dir: true },
  Glob: { field: 'path', weight: 1, dir: true },
}

// In the session's memory (it outlives a hot reload of the mod, not a restart), nothing on disk:
// the transcript's path once found; background tasks seen starting while this process runs, and
// ending; whether a turn is running; how many rows the conversation had when this process started
// (a background task started before that died with the process that ran it).
const transcript = atom({ plugin: 'nametag', key: 'transcript' } as const, null)
const work = atom({ plugin: 'nametag', key: 'work' } as const, null as Record<string, number> | null)
const ended = atom({ plugin: 'nametag', key: 'ended' } as const, null as string[] | null)
const turning = atom({ plugin: 'nametag', key: 'inTurn' } as const, false as boolean | null)
const origin = atom({ plugin: 'nametag', key: 'from' } as const, null as number | null)

let lastActivity = 0 // from the transcript at start, then from the session's prompts and turns
let sleeping: Promise<void> | undefined // the rename job in flight (see serial)
let wakePending = false // the last attempt to take the mark off must be tried again
let personRenames = 0 // the person's /renames seen so far
let personName = '' // the name the last of them gave
let topicOff = false // /topic off, from the transcript at start, then from the command
let misses = 0 // model checks in a row that found nothing
let maxWords = 1 // words in a topic, from `topic_words`
let stuck = '' // a name this mod set that the transcript never showed: not tried again and again
let scanAfter = 0
let interactive = false
let asking = false // a model check for the topic is under way
let adoptPending = false // /clear or a resume: the process goes on under another session
// The transcript's size and time, and the level, when a check last found the name as it should be:
// an idle session whose transcript hasn't changed since, with no new level due, is not read again.
let settled = { key: '', level: -1 }
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
  topic: boolean; topicSep: string; topicOpen: string; topicClose: string; topicModel: string
}

const BRACKETS: Record<string, [string, string]> = { '[]': ['[', ']'], '()': ['(', ')'], '{}': ['{', '}'], '<>': ['<', '>'] }

export function style(options: Record<string, unknown>): Style {
  const sep = typeof options.separator === 'string' ? options.separator.trim() : ''
  const pair = typeof options.brackets === 'string' ? BRACKETS[options.brackets.replace(/\s/g, '')] : undefined
  const tb = typeof options.topic_brackets === 'string' ? options.topic_brackets : '[]'
  const topicPair = BRACKETS[tb.replace(/\s/g, '')]
  const model = typeof options.topic_model === 'string' && options.topic_model.trim() !== '' ? options.topic_model.trim() : 'haiku'
  return {
    levels: levels(options), atEnd: options.position === 'end', sep, open: pair?.[0] ?? '', close: pair?.[1] ?? '',
    topic: options.topic === 'on',
    // a topic with neither brackets nor a separator couldn't be told apart from the name: '·' then
    topicSep: typeof options.topic_separator === 'string' && options.topic_separator.trim() !== '' ? options.topic_separator.trim() : (topicPair ? '' : '·'),
    topicOpen: topicPair?.[0] ?? '', topicClose: topicPair?.[1] ?? '',
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

// The end of the transcript: the whole file when $.fs.read can take it, else its last TAIL_BYTES
// through `tail`. `whole` says whether that is all of it. Undefined when it can't be read.
async function transcriptEnd($: Engine): Promise<{ text: string; whole: boolean; path: string } | undefined> {
  const path = await transcriptPath($)
  if (!path) return undefined
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file') return undefined
    if (st.size <= FS_READ_MAX) return { text: await $.fs.read(path), whole: true, path }
  } catch {
    return undefined
  }
  try {
    const r = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 10000 })
    if (r.exitCode === 0) return { text: r.stdout, whole: false, path }
  } catch {}
  return { text: '', whole: false, path }
}

// The transcript's rows that hold `needle`, all of them (the system's search tool for a big file).
async function rowsWith($: Engine, path: string, needle: string): Promise<string | undefined> {
  for (const argv of [['grep', '-a', '-F', needle, path], ['findstr', '/L', `/C:${needle}`, path]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 20000 })
      if (r.exitCode === 0 || r.exitCode === 1) return r.stdout
    } catch {}
  }
  return undefined
}

// The session's name as it is now: a string, null when the session was never named, or undefined
// when the transcript can't be found or read (try again later). Claude Code writes the title row
// again at each prompt, so the end of the transcript nearly always holds the newest.
async function currentName($: Engine): Promise<string | null | undefined> {
  const end = await transcriptEnd($)
  if (!end) return undefined
  const t = newestTitle(end.text)
  if (t !== null || end.whole) return t
  const rows = await rowsWith($, end.path, TITLE_ROW)
  return rows === undefined ? undefined : newestTitle(rows)
}

// When the session last had activity, from the transcript: the newest timestamped row of the
// conversation itself (a prompt, a reply, a tool result, a background task's notice). Renames,
// the meta rows Claude Code adds after them, notices and bookkeeping rows don't count. Null when
// none is found.
export function lastActivityIn(text: string): number | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.includes('"timestamp"') || !(l.includes('"type":"user"') || l.includes('"type":"assistant"'))) continue
    try {
      const row = JSON.parse(l)
      // Not a meta row: Claude Code adds one after every rename ("The user named this session..."),
      // from this mod (origin plugin) or the person; a turn that follows has rows of its own.
      // Nor a synthetic reply: a resume (--continue) writes "No response requested." as model <synthetic>.
      if (row?.isMeta === true || row?.origin?.kind === 'plugin' || row?.message?.model === '<synthetic>') continue
      if ((row?.type === 'user' || row?.type === 'assistant') && typeof row.timestamp === 'string') {
        const t = Date.parse(row.timestamp)
        if (!Number.isNaN(t)) return t
      }
    } catch {}
  }
  return null
}

async function transcriptActivity($: Engine): Promise<number | null> {
  const end = await transcriptEnd($)
  return end ? lastActivityIn(end.text) : null
}

// ---- the name, taken apart ---------------------------------------------------------------------

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The name as this mod builds it, taken apart: the person's name, the levels of the mark on it, the
// topic at its end. A mark in another style (the options changed) is taken off too, when it is a
// run of the level emojis or 💤 at the front or the end. A name that only looks built ("💤 Notes", typed so)
// is read the same way: the transcript can't say who set it.
export function decompose(name: string, st: Style): { base: string; level: number; topic: string | null } {
  let rest = name
  let topic: string | null = null
  const sep = st.topicSep === '' ? ' ' : ` ${escape(st.topicSep)} `
  const t = !st.topic ? null : new RegExp(`${sep}${escape(st.topicOpen)}([\\p{L}\\p{N}._-]{1,${TOPIC_MAX_LEN}})${escape(st.topicClose)}$`, 'u').exec(rest)
  if (t && t.index > 0) {
    topic = t[1]!
    rest = rest.slice(0, t.index)
  }
  for (let n = st.levels.length; n >= 1; n--) {
    const [pre, post] = marked('\u0000', st, n).split('\u0000') as [string, string]
    if (rest.length > pre.length + post.length && rest.startsWith(pre) && rest.endsWith(post)) {
      return { base: rest.slice(pre.length, rest.length - post.length), level: n, topic }
    }
  }
  // another style: the emojis, maybe in brackets, joined by a space or a short separator of signs
  const emojis = [...new Set(['💤', ...st.levels.map(l => l.emoji)])].map(escape).join('|')
  const mark = `[[({<]?(?:${emojis})+[\\])}>]?`
  const join = '\\s+(?:[^\\p{L}\\p{N}\\s]{1,3}\\s+)?'
  const front = new RegExp(`^${mark}${join}`, 'u').exec(rest)
  if (front && rest.length > front[0].length) return { base: rest.slice(front[0].length), level: 1, topic }
  const back = new RegExp(`${join}${mark}$`, 'u').exec(rest)
  if (back && back.index > 0) return { base: rest.slice(0, back.index), level: 1, topic }
  return { base: rest, level: 0, topic }
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

// Sets the name, read right then, to the person's name under it with the mark of `want.level` levels
// and the topic `want.topic` (each left as the name has it when not given). Returns 'retry' when it
// should be tried again later (the name couldn't be read, or the rename failed).
type Want = { level?: number; topic?: string | null }

async function render($: Engine, st: Style, want: Want): Promise<'done' | 'retry'> {
  const seen = personRenames
  const name = await currentName($)
  if (name === undefined) return 'retry'
  if (name === null || name.trim() === '') return 'done'
  const now = decompose(name, st)
  const level = Math.min(want.level ?? now.level, st.levels.length)
  let topic = want.topic !== undefined ? want.topic : now.topic
  if (!st.topic || topicOff || (topic && inName(now.base, topic))) topic = null
  const target = build(now.base, st, level, topic)
  if (target === name) {
    stuck = ''
    return 'done'
  }
  if (target === stuck) return 'done' // renamed to it before, and the transcript never showed it
  if (!(await rename($, target))) return 'retry'
  if ((await currentName($)) !== target && personRenames === seen) stuck = target
  if (personRenames !== seen && personName && (await currentName($)) !== personName) {
    // The person's /rename ran while this one waited its turn in the command queue, and this one,
    // run after it, replaced their name: theirs stands, built on at the next check.
    await rename($, personName)
  }
  return 'done'
}

// Takes the mark off, the topic stays. One that fails is tried again by the tick.
async function unmark($: Engine, st: Style): Promise<void> {
  wakePending = (await render($, st, { level: 0 })) === 'retry'
}

// Runs `fn` after any rename in flight, as one: ticks skip while it runs.
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

// ---- work in the background ----------------------------------------------------------------

// A command, workflow or agent working in the background keeps the session from being idle. Agents
// (subagents, teammates) are in $.agent.list(). Background commands and workflows have no such list:
// they are the ones the conversation put in the background since this process started, less those
// it has an end notice for (the notice names the task id) or that TaskStop stopped. The tool calls
// seen while the session runs count too, in case the conversation's copy lacks a result. A Monitor
// is a watch, not work, and doesn't count.
export function startedTask(tool: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (tool === 'Bash' && typeof r.backgroundTaskId === 'string' && r.backgroundEndsWithFinalResponse !== true) return r.backgroundTaskId
  if (tool === 'Workflow' && typeof r.taskId === 'string' && (r.status === 'async_launched' || r.status === 'remote_launched')) return r.taskId
  return null
}

const TASK_ID = /<task-id>([^<]+)<\/task-id>/g

// Whether a notice names the task id as a whole word ("b1" is not in "b12").
export function mentions(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(text)
}

// The background tasks the conversation shows running: started from row `from` on, with no notice
// of their end anywhere.
export function runningTasks(messages: readonly { role: string; text: string; toolUses?: readonly { tool: string; result?: unknown }[] }[], from: number): Set<string> {
  const started = new Set<string>()
  const done = new Set<string>()
  messages.forEach((m, i) => {
    for (const u of m.toolUses ?? []) {
      const id = startedTask(u.tool, u.result)
      if (id && i >= from) started.add(id)
      const stopped = u.tool === 'TaskStop' ? (u.result as { task_id?: unknown } | undefined)?.task_id : undefined
      if (typeof stopped === 'string') done.add(stopped)
    }
    if (m.role === 'user') for (const x of m.text.matchAll(TASK_ID)) done.add(x[1]!.trim())
  })
  for (const id of done) started.delete(id)
  return started
}

async function busy($: Engine): Promise<boolean> {
  const now = await $.clock.now()
  const gone = new Set((await read($, ended)) ?? [])
  const live = Object.entries((await read($, work)) ?? {}).filter(([id, at]) => !gone.has(id) && now - at <= WORK_MAX_MS)
  let messages: Parameters<typeof runningTasks>[0] | undefined
  try { messages = await $.session.messages() } catch {}
  if (live.length) {
    // a notice the conversation holds ends a task too (one delivered into a running turn, say)
    const notices = (messages ?? []).filter(m => m.role === 'user' && m.text.includes('<task-id>')).map(m => m.text)
    if (live.some(([id]) => !notices.some(t => mentions(t, id)))) return true
  }
  if (messages) {
    const running = runningTasks(messages, (await read($, origin)) ?? 0)
    for (const id of gone) running.delete(id)
    if (running.size) return true
  }
  try {
    return (await $.agent.list()).some(a => AGENT_BUSY.has(a.status))
  } catch {
    return false
  }
}

// ---- idle -----------------------------------------------------------------------------------

function due(st: Style, idle: number): number {
  return st.levels.filter(l => idle >= l.ms).length
}

async function active($: Engine): Promise<void> {
  lastActivity = await $.clock.now()
}

// Once a minute, cheapest check first: a rename or a turn running, no level due by the activity
// this process saw (the clock); then the transcript's own last activity, work in the background,
// and only then the name, read right then and set to the levels due (nothing to rename when it
// already has them).
async function tick($: Engine, st: Style): Promise<void> {
  if (sleeping || (await read($, turning))) return
  if (adoptPending) await adopt($, st)
  if (wakePending) return void serial($, () => unmark($, st))
  const now = await $.clock.now()
  const cheap = due(st, now - lastActivity)
  if (cheap === 0) return
  const key = await transcriptKey($)
  if (key !== '' && key === settled.key && cheap === settled.level) return // nothing new since
  const t = await transcriptActivity($)
  if (t !== null && t > lastActivity) lastActivity = Math.min(t, now)
  const n = due(st, now - lastActivity)
  if (n === 0) return
  if (await busy($)) return active($)
  const since = lastActivity
  await serial($, async () => {
    if (lastActivity !== since) return
    if ((await render($, st, { level: n })) === 'retry') return // tried again at the next tick
    // after the rename (its rows change the transcript); a level that was due by the clock alone
    if (lastActivity === since && due(st, (await $.clock.now()) - lastActivity) === n) settled = { key: await transcriptKey($), level: n }
  })
}

// The transcript's size and modification time, '' when it can't be found.
async function transcriptKey($: Engine): Promise<string> {
  try {
    const path = await transcriptPath($)
    if (!path) return ''
    const s = await $.fs.stat(path)
    return s.kind === 'file' ? `${s.size}:${s.mtimeMs}` : ''
  } catch {
    return ''
  }
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
  return name.startsWith('.') ? null : cleanTopic(name, null, 'last', maxWords)
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

// A root that holds projects of its own (a folder in it has .git, the root none): each folder in it
// is a project.
async function isWorkspace($: Engine, root: string): Promise<boolean> {
  if (workspace?.root === root) return workspace.is
  let is = false
  // a repository itself is one project, whatever it holds (a submodule has a .git of its own)
  if (await hasGit($, root)) { workspace = { root, is }; return is }
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
  if (!/^(\/|[A-Za-z]:\/)/.test(p)) return null // absolute only: /home/... or C:/...
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

// The project the session's last PATH_WINDOW path tool calls point at, read from the conversation
// as it is now (a restart or reload loses nothing), or null.
async function pathLeader($: Engine): Promise<string | null> {
  const msgs = await $.session.messages()
  const weights: Record<string, number> = {}
  let total = 0
  let seen = 0
  for (let i = msgs.length - 1; i >= 0 && seen < PATH_WINDOW; i--) {
    const uses = msgs[i]!.toolUses ?? []
    for (let j = uses.length - 1; j >= 0 && seen < PATH_WINDOW; j--) {
      const u = uses[j]!
      const t = PATH_TOOLS[u.tool]
      const path = t ? u.input?.[t.field] : undefined
      if (!t || typeof path !== 'string') continue
      seen++
      total += t.weight
      const project = await projectOf($, path, t.dir === true)
      if (project) weights[project] = (weights[project] ?? 0) + t.weight
    }
  }
  return leader(weights, total)
}

// The project that clearly leads the path weight, or null.
export function leader(weights: Record<string, number>, total: number): string | null {
  let best: string | null = null
  let most = 0
  for (const [k, v] of Object.entries(weights)) if (v > most) { best = k; most = v }
  return best !== null && most >= TOPIC_MIN_WEIGHT && most >= TOPIC_SHARE * total ? best : null
}

const NOISE = /<(command-name|command-message|local-command|task-notification|system-reminder)|^Session renamed to/

// The last prompts and replies, one line each, oldest first: CONTEXT_PROMPTS of the person's,
// CONTEXT_REPLIES of Claude's (short prompts only make sense among the others).
export function recentLines(messages: readonly { role: string; text: string }[]): string[] {
  const out: string[] = []
  let users = 0
  let claudes = 0
  for (let i = messages.length - 1; i >= 0 && users + claudes < CONTEXT_PROMPTS + CONTEXT_REPLIES; i--) {
    const m = messages[i]!
    const t = m.text.trim()
    if (!t || NOISE.test(t)) continue
    if (m.role === 'user' && users < CONTEXT_PROMPTS) { users++; out.push(`User: ${t.replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS)}`) }
    else if (m.role === 'assistant' && claudes < CONTEXT_REPLIES) { claudes++; out.push(`Claude: ${t.replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS)}`) }
  }
  return out.reverse()
}

// The model's answer as a label: one line, letters, digits, '.', '_' and '-', `most` words at most
// (`keep` says which: a folder like "cc-mod-billing-api" says most in its last ones, or, kept to one
// word, its longest), and
// TOPIC_MAX_LEN characters at most. SAME keeps `current`. Null when nothing usable is left.
export function cleanTopic(text: string, current: string | null, keep: 'first' | 'last' = 'first', most = TOPIC_MAX_WORDS): string | null {
  const line = (text.trim().split('\n')[0] ?? '').trim().replace(/^["'`*]+|["'`*.]+$/g, '')
    .replace(/^(topic|label|answer)\s*:\s*/i, '').replace(/^["'`*]+/, '') // "Topic: billing"
  if (/^same\b/i.test(line)) return current // "SAME", "SAME (billing)"
  const slug = line
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const words = slug.split(/[-_]+/).filter(Boolean)
  // a folder kept to one word keeps its longest ("billing-api" gives "billing"), the last on a tie
  const longest = words.reduce((best, w) => (w.length >= best.length ? w : best), '')
  const two = keep === 'last' ? (most === 1 ? longest : words.slice(-most).join('-')) : words.slice(0, most).join('-')
  const label = two.slice(0, TOPIC_MAX_LEN).replace(/[-._]+$/, '')
  return label === '' ? null : label
}

const TOPIC_SYSTEM = 'You give work sessions a short topic. Reply with the topic only.'

async function askModel($: Engine, st: Style, current: string | null, lines: string[]): Promise<string | null> {
  const shape = maxWords === 1 ? 'a single word, like "billing" or "docs"' : 'one word, or two joined by a hyphen, like "billing-api" or "docs-site"'
  const prompt = [
    'The goal: a short topic that lets someone glancing at a list of their sessions tell at once what',
    `this one is working on now. Answer with ${shape}, nothing else. The person's prompts are often`,
    'short and only make sense together, so read them as one conversation and go by the newest work.',
    '',
    `Current topic: ${current ?? 'none'}`,
    '',
    'Recent messages, oldest first:',
    ...lines,
    '',
    'If the current topic still fits the work now, reply SAME.',
  ].join('\n')
  let r: Awaited<ReturnType<Engine['model']['complete']>>
  try {
    // low effort: an easy task; the room in maxTokens is for any thinking, so it can't crowd out the answer
    r = await $.model.complete({ model: st.topicModel, system: TOPIC_SYSTEM, prompt, maxTokens: 1000, effort: 'low', timeoutMs: 30000 })
  } catch (err) {
    $.ui.log(`nametag: topic: ${err}`, { to: 'debug' }) // refused (an unknown model, say): a miss
    return null
  }
  if (!r.isAnswered) {
    $.ui.log(`nametag: topic: ${'reason' in r ? String(r.reason) : 'no answer'}`, { to: 'debug' })
    return null
  }
  return cleanTopic(r.text, current, 'first', maxWords)
}


// ---- the topic ------------------------------------------------------------------------------

// /topic off or on: the last such command in the transcript. Off only when it says so.
export function lastTopicCommand(rows: string): boolean | null {
  let off: boolean | null = null
  for (const l of rows.split('\n')) {
    if (!l.includes(TOPIC_ROW)) continue
    const m = /<command-args>\s*(\w+)/.exec(l)
    if (m?.[1] === 'off') off = true
    else if (m?.[1] === 'on') off = false
  }
  return off
}

async function readTopicOff($: Engine): Promise<boolean> {
  const end = await transcriptEnd($)
  if (!end) return false
  const rows = end.whole ? end.text : await rowsWith($, end.path, TOPIC_ROW)
  return rows ? (lastTopicCommand(rows) ?? false) : false
}

// The last model check, the one thing kept between runs: so a restart can't ask again sooner.
function askedKey(id: string): string {
  return `asked:${id}`
}

// Drops everything in the store but the last model checks of the last KEEP_DAYS (and so whatever
// an earlier version kept).
async function prune($: Engine): Promise<void> {
  const cutoff = (await $.clock.now()) - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const key of await $.store.keys()) {
    const v = await $.store.get(key)
    if (!key.startsWith('asked:') || typeof v !== 'number' || v < cutoff) await $.store.delete(key)
  }
}

// The person's name under the mark and the topic now on it, read right then. Null: unnamed or unreadable.
async function named($: Engine, st: Style): Promise<{ base: string; current: string | null } | null> {
  let out: { base: string; current: string | null } | null = null
  await serial($, async () => {
    const name = await currentName($)
    if (!name || name.trim() === '') return
    const d = decompose(name, st)
    out = { base: d.base, current: d.topic }
  })
  return out
}

function setTopic($: Engine, st: Style, topic: string): Promise<void> {
  return serial($, () => render($, st, { topic }))
}

// When the session starts and at the end of each turn of the main conversation, cheapest test
// first, from the conversation as it is then. The paths first: when one project leads them, it is
// the topic, with no model call. Otherwise the model, once the person has written TOPIC_MIN_PROMPTS
// prompts and 10 minutes have passed since its last check; a check that found nothing (the model
// failed, or only gave the name back) doubles the wait, up to 2 hours.
async function topicTurn($: Engine, st: Style, idle = false): Promise<void> {
  if (adoptPending) await adopt($, st)
  if (!st.topic || !interactive || topicOff) return
  const project = await pathLeader($)
  if (project !== null) {
    const n = await named($, st)
    if (!n || n.current === project || inName(n.base, project)) return
    await setTopic($, st, project)
    return
  }
  if (asking) return // one check at a time: turns that end while one waits don't each ask
  asking = true
  try {
    await askTopic($, st, idle)
  } finally {
    asking = false
  }
}

async function askTopic($: Engine, st: Style, idle: boolean): Promise<void> {
  const id = await $.session.id()
  const now = await $.clock.now()
  if (idle && (await named($, st))?.current) return // nothing new since: the topic it has stands
  const at = await $.store.get(askedKey(id))
  const since = typeof at !== 'number' || at > now ? Infinity : now - at
  if (since < Math.min(TOPIC_RATE_MS * 2 ** misses, TOPIC_MAX_WAIT_MS)) return
  const lines = recentLines(await $.session.messages())
  if (lines.filter(l => l.startsWith('User: ')).length < TOPIC_MIN_PROMPTS) return // too little to go on
  const n = await named($, st)
  if (!n) return // no model call
  await $.store.set(askedKey(id), now)
  let label = await askModel($, st, n.current, lines)
  if (label && inName(n.base, label)) label = null
  misses = label ? 0 : misses + 1
  if (label && label !== n.current) await setTopic($, st, label)
}

// The session the process goes on with after a /clear or a resume (no session.start fires for it):
// what was known of the old one goes; this one's last activity and /topic come from its transcript,
// and its background tasks from before died with the process that ran them.
async function adopt($: Engine, st: Style): Promise<void> {
  adoptPending = false
  const now = await $.clock.now()
  const rows = await $.session.messages().then(m => m.length, () => 0)
  await update($, work, () => null)
  await update($, ended, () => null)
  await update($, origin, () => rows)
  const t = await transcriptActivity($).catch(() => null)
  lastActivity = t !== null && t <= now ? t : now
  topicOff = st.topic ? await readTopicOff($).catch(() => false) : false
  misses = 0
  settled = { key: '', level: -1 }
}

// ---- hooks ---------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const st = style(options)
  maxWords = options.topic_words === 2 ? 2 : 1

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    interactive = e.isInteractive
    if (!e.isInteractive) return r
    await prune($).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
    // A start (restart, resume, reload) is not activity: the idle time runs from the transcript's
    // last activity, and the name gets the levels that time calls for right away, no more and no
    // less. A session with no activity yet starts counting now. Not awaited: a rename waits for a
    // running turn; ticks skip while it runs.
    const now = await $.clock.now()
    const t = await transcriptActivity($).catch(() => null)
    lastActivity = t !== null && t <= now ? t : now
    if ((await read($, origin)) === null) {
      // a restart: tasks started before it died with the process that ran them
      const rows = await $.session.messages().then(m => m.length, () => 0)
      await update($, origin, () => rows)
    }
    const n = (await read($, turning)) ? 0 : due(st, now - lastActivity)
    void serial($, () => (n === 0 ? unmark($, st) : render($, st, { level: n })))
    if (st.topic) {
      topicOff = await readTopicOff($).catch(() => false)
      await $.command.register({ name: 'topic', description: 'nametag: turn the topic at the end of this session\'s name off or on', argumentHint: 'off | on' }).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      // an idle session restarted: the paths, free, but no model call when it already has a topic
      topicTurn($, st, n > 0).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
    }
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
    if (adoptPending) await adopt($, st) // first, so this turn's own work is kept
    if (e.origin?.kind !== 'plugin') await active($)
    if (e.origin?.kind === 'task-notification') {
      const ids = [...e.text.matchAll(TASK_ID)].map(x => x[1]!.trim())
      for (const id of Object.keys((await read($, work)) ?? {})) if (mentions(e.text, id)) ids.push(id)
      if (ids.length) await update($, ended, g => [...(g ?? []), ...ids])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // `/topic off` / `/topic on`, for this session. Not awaited: the rename waits for the session to be idle.
  on('command.run', { command: 'topic' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      topicOff = true
      void serial($, () => render($, st, { topic: null }))
      return { text: 'no topic for this session (/topic on to bring it back)' }
    }
    if (arg === 'on') {
      topicOff = false
      misses = 0
      await $.store.delete(askedKey(await $.session.id()))
      topicTurn($, st).catch(err => $.ui.log(`nametag: ${err}`, { to: 'debug' }))
      return { text: 'topic on for this session' }
    }
    return { text: `topic is ${topicOff ? 'off' : 'on'} for this session; /topic off or /topic on` }
  })

  // The person renames the session: a command typed in the session, so activity. Their name is
  // built on from the next check.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'rename' || e.origin?.kind === 'plugin') return next(e)
    personRenames++
    personName = e.args.trim()
    await active($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Work put in the background or stopped, in any agent's loop, as it happens.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('deny' in r && r.deny !== undefined) && !r.isError) {
        const id = startedTask(e.tool, r.result)
        const now = await $.clock.now()
        // the main loop's: a subagent's own end notices go to its loop, and it is busy while it runs
        if (id && !e.agentId) await update($, work, w => ({ ...(w ?? {}), [id]: now }))
        if (e.tool === 'TaskStop') {
          const stopped = (r.result as { task_id?: unknown } | undefined)?.task_id
          if (typeof stopped === 'string') await update($, ended, g => [...(g ?? []), stopped])
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
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') adoptPending = true
    return next(e)
  })

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
