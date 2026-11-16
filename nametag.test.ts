import { expect, mock, test } from 'claude-code/testing'
import { bridgeBehind, cleanTopic, decompose, lastActivityIn, lastTopicCommand, leader, mentions, recentLines, runningTasks, style, turnEndedIn } from './hooks/register'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONFIG = '/u/.claude'
const PROJECTS = ['-other-project', '-work-demo']
const MIN = 60 * 1000
const HOUR = 60 * MIN

// A fake world beneath the mod: one transcript, /rename appending a title row to it.
let current: any // the world of the test that runs

function world(on: any, opts: { name?: string; size?: number; env?: Record<string, string>; path?: string } = {}) {
  const w = {
    text: '{"type":"user","message":"hello"}\n', renames: [] as string[], greps: 0, reads: 0, lists: 0, attempts: 0,
    blocked: false, failRenames: 0, logs: [] as string[], store: new Map<string, unknown>(), gate: undefined as Promise<void> | undefined, id: ID,
    modelGate: undefined as Promise<void> | undefined, modelRefuses: false,
    agents: [] as { id: string; status: string }[], results: {} as Record<string, unknown>, agentLists: 0,
    git: new Set<string>(), files: new Map<string, string>(), dirs: {} as Record<string, string[]>, messages: [] as { role: string; text: string }[],
    answers: [] as string[], calls: [] as { effort?: string; maxTokens?: number }[], asks: 0, prompts: [] as string[], tails: 0,
    metaAt: 0, // when set, each rename also adds the meta row Claude Code writes after one, at this time
    localAt: 0, // when set, each rename also adds the /rename rows Claude Code writes before its title, at this time
    title: (name: string) => { w.text += JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: w.id }) + '\n' },
    // a prompt (or reply) in the transcript at `ms`
    row: (ms: number, type = 'user') => { w.text += JSON.stringify({ type, timestamp: new Date(ms).toISOString(), message: { content: 'x' } }) + '\n' },
  }
  const pathOf = () => opts.path ?? `${CONFIG}/projects/-work-demo/${w.id}.jsonl`
  current = w
  const title = w.title
  if (opts.name !== undefined) title(opts.name)
  mock.env(on, opts.env ?? { CLAUDE_CONFIG_DIR: CONFIG })
  on('store.get', (_: unknown, e: { key: string }) => ({ value: w.store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => { w.store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_: unknown, e: { key: string }) => { w.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: w.messages.map((m: any) => ({ ...m, toolUses: m.toolUses ?? [] })) }))
  on('model.complete', async (_: unknown, e: { prompt: string; effort?: string; maxTokens?: number }) => {
    w.asks++
    w.calls.push({ effort: e.effort, maxTokens: e.maxTokens })
    if (w.modelGate) await w.modelGate
    if (w.modelRefuses) throw new Error('model refused')
    w.prompts.push(String(e.prompt))
    const text = w.answers.shift()
    return { value: text === undefined ? { isAnswered: false, reason: 'api-error' } : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('agent.list', () => (w.agentLists++, { value: w.agents.map(a => ({ description: 'x', type: 'general-purpose', ...a })) }))
  on('tool.call', (_: unknown, e: { tool: string }) => ({ result: w.results[e.tool] ?? {} }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: { turnId: string; text: string }) => (w.messages.push({ role: 'user', text: e.text }), { turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('ui.log', (_: unknown, e: { text: string }) => { w.logs.push(e.text); return { value: undefined } })
  on('session.id', () => ({ value: w.id }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (e.path !== pathOf() || w.blocked) throw new Error('ENOENT')
    return { value: { kind: 'file', size: opts.size ?? w.text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path !== pathOf()) throw new Error('ENOENT')
    w.reads++
    return { value: w.text }
  })
  // a test runs on POSIX, where a drive path ("C:/x") reaches the fake resolved against the cwd
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === pathOf() || w.files.has(e.path) || w.git.has(e.path.replace(/^.*\/(?=[A-Za-z]:\/)/, '')) }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_: unknown, e: { path: string }) => {
    w.lists++
    if (w.dirs[e.path]) return { value: w.dirs[e.path]!.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
    if (e.path !== `${CONFIG}/projects`) throw new Error('ENOENT')
    return { value: [...PROJECTS, pathOf().split('/').at(-2)].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[0] === 'tail') {
      w.tails++
      return { value: { exitCode: 0, stdout: w.text.slice(-Number(e.argv[2])), stderr: '' } }
    }
    w.greps++
    const needle = e.argv[0] === 'grep' ? e.argv[3]! : '"type":"custom-title"'
    const file = e.argv.at(-1)! // grep's or findstr's
    const sub = /\/subagents\/agent-([^/]+)\.jsonl$/.exec(file)
    if (sub) {
      const text = (w as any).subagents?.[sub[1]!]
      if (text === undefined || file !== `${pathOf().replace(/\.jsonl$/, '')}/subagents/agent-${sub[1]}.jsonl`) return { value: { exitCode: 2, stdout: '', stderr: 'No such file' } }
      const found = text.split('\n').filter((l: string) => l.includes(needle))
      return { value: { exitCode: found.length ? 0 : 1, stdout: found.join('\n'), stderr: '' } }
    }
    const hits = w.text.split('\n').filter(l => l.includes(needle))
    return { value: { exitCode: hits.length ? 0 : 1, stdout: hits.join('\n'), stderr: '' } }
  })
  on('command.run', async (_: unknown, e: { command: string; args: string; origin?: { kind: string } }) => {
    if (e.command === 'rename') {
      w.attempts++
      if (w.gate && e.origin?.kind !== 'composer') await w.gate // the person's own run at once
      if (w.failRenames > 0) { w.failRenames--; throw new Error('rename refused') }
      w.renames.push(e.args)
      if (w.localAt) w.text += JSON.stringify({ type: 'system', subtype: 'local_command', content: `<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>${e.args}</command-args>`, timestamp: new Date(w.localAt).toISOString() }) + '\n'
      title(e.args)
      if (w.metaAt) w.text += JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'plugin', name: 'nametag' }, message: { content: `The user named this session "${e.args}"` }, timestamp: new Date(w.metaAt).toISOString() }) + '\n'
    }
    return { text: `Session renamed to: ${e.args}` }
  })
  return w
}

// The store's keys other than the saved last activity.
function marks(w: { store: Map<string, unknown> }) {
  return [...w.store.keys()].filter(k => !k.startsWith('seen:') && k !== 'styles')
}

// The person types /rename.
async function personRename($: any, name: string) {
  await $.command.run({ command: 'rename', args: name, origin: { kind: 'composer' } })
  await settle()
}

// A record as the mod keeps it while a session is marked.
function preset(_w: unknown, _id: string, _set: string, _base: string, _at = 1_000_000) {
  // 0.14: no record is kept; the name itself says it all
}

// Lets the rename jobs the mod queued without waiting for them run to their end.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

async function start($: any, isInteractive = true) {
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive })
  await settle()
}

async function turn($: any, id: string) {
  await $.turn.start({ text: 'hi', turnId: id } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' } as any)
  await settle()
}

test('sleeps after 10 idle minutes and wakes after the next turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(9 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(30 * MIN) // stays asleep, no second rename
  expect(w.renames).toEqual(['💤 Builder'])
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
  await turn($, 't2') // awake: no transcript read, no rename
  expect(w.renames.length).toBe(2)
})

test('activity resets the idle timer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(8 * MIN)
  await turn($, 't1')
  await clock.advance(8 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(3 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a session that was never named is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await clock.advance(20 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual([])
})

test('non-interactive sessions are left alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($, false)
  await clock.advance(20 * MIN)
  expect(w.renames).toEqual([])
})

test('a transcript over 4 MiB is read from its end, and searched with grep when the end has no title', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Big one', size: 20 * 1024 * 1024 })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Big one'])
  expect(w.tails).toBeGreaterThan(0)
  expect(w.greps).toBe(0)
  expect(w.reads).toBe(0)
  w.text += 'x'.repeat(600 * 1024) + '\n' // the title row is now far from the end
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Big one', 'Big one'])
  expect(w.greps).toBeGreaterThan(0)
})

test('options: delays and emojis per level', { options: { level1_minutes: 2, level1_emoji: '1️⃣', level2_minutes: 5, level2_emoji: '2️⃣', level3_minutes: 9, level3_emoji: '3️⃣' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(3 * MIN)
  await clock.advance(3 * MIN)
  await clock.advance(4 * MIN)
  expect(w.renames).toEqual(['1️⃣ Builder', '1️⃣2️⃣ Builder', '1️⃣2️⃣3️⃣ Builder'])
  await turn($, 't1')
  expect(w.renames.at(-1)).toBe('Builder')
})

test('an empty emoji turns a level off', { options: { level2_emoji: '' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await clock.advance(4 * HOUR)
  await clock.advance(9 * HOUR)
  expect(w.renames).toEqual(['💤 Builder', '💤💤 Builder'])
})

test('climbs three levels: 10 minutes, 3 hours, 12 hours', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(2 * HOUR + 40 * MIN) // 2h51m
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(10 * MIN) // 3h01m
  expect(w.renames).toEqual(['💤 Builder', '💤💤 Builder'])
  await clock.advance(9 * HOUR) // 12h01m
  expect(w.renames).toEqual(['💤 Builder', '💤💤 Builder', '💤💤💤 Builder'])
  await clock.advance(24 * HOUR) // stays at level 3
  expect(w.renames.length).toBe(3)
  await turn($, 't1')
  expect(w.renames.at(-1)).toBe('Builder')
})

test('an unreadable spell ends straight at the level reached', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  w.blocked = true
  await clock.advance(4 * HOUR)
  expect(w.renames).toEqual([])
  w.blocked = false
  await clock.advance(1 * MIN)
  expect(w.renames).toEqual(['💤💤 Builder'])
})

test('a name that only starts with the emoji is not taken for a mark', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 💤Builder', '💤Builder'])
})

test('uses HOME/.claude without CLAUDE_CONFIG_DIR', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', env: { HOME: '/u' } })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a transcript it cannot find leaves the name alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', env: { HOME: '/elsewhere' } })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual([])
})

test('finds the transcript in a shortened project folder by its session id', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', path: `${CONFIG}/projects/-work-de-1a2b3c/${ID}.jsonl` })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a subagent turn does not wake the session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer' } as any)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('style: the mark after the name', { options: { position: 'end' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder 😑' })
  await start($)
  await clock.advance(11 * MIN)
  await clock.advance(3 * HOUR)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder 😑 💤', 'Builder 😑 💤💤', 'Builder 😑'])
})

test('style: a separator', { options: { separator: '-' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await clock.advance(3 * HOUR)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 - Builder', '💤💤 - Builder', 'Builder'])
})

test('style: brackets, separator and end together', { options: { position: 'end', separator: '|', brackets: '[]' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await clock.advance(3 * HOUR)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder | [💤]', 'Builder | [💤💤]', 'Builder'])
})

test('style: brackets alone', { options: { brackets: '()' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['(💤) Builder', 'Builder'])
})

test('a name ending in an unmarked emoji is left alone', { options: { position: 'end' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder 😑' })
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual([])
})

test('a refused rename is tried again on the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.failRenames = 1
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  expect(w.attempts).toBe(2)
})

test('a prompt during a rename: the mark still comes off after the turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  let open = () => {}
  w.gate = new Promise<void>(r => { open = r })
  await start($)
  await clock.advance(10 * MIN + 30 * 1000) // the tick's rename is now waiting
  expect(w.attempts).toBe(1)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  const done = $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  w.gate = undefined
  open()
  await done
  await settle() // the wake, queued behind the tick's rename
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
  await clock.advance(11 * MIN) // the reset stands: the next idle spell marks again
  expect(w.renames).toEqual(['💤 Builder', 'Builder', '💤 Builder'])
})

test('a name that starts with the mark is read as marked (the transcript can\'t say who set it)', { options: { position: 'end' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Notes' })
  await start($)
  expect(w.renames).toEqual(['Notes'])
})

test('a name that is only the emoji', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤' })
  await start($)
  await clock.advance(11 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 💤', '💤'])
})

for (const sep of ['.*', '$', '\\', '(', '|']) {
  test(`separator ${sep}`, { options: { separator: sep } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on, { name: 'Builder' })
    await start($)
    await clock.advance(11 * MIN)
    await turn($, 't1')
    expect(w.renames).toEqual([`💤 ${sep} Builder`, 'Builder'])
  })
}

for (const brackets of ['[]', '()', '{}', '<>']) {
  test(`brackets ${brackets} at the end`, { options: { brackets, position: 'end' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on, { name: 'Builder' })
    await start($)
    await clock.advance(11 * MIN)
    await turn($, 't1')
    expect(w.renames).toEqual([`Builder ${brackets[0]}💤${brackets[1]}`, 'Builder'])
  })
}

test('a ZWJ emoji name is not taken for a mark of its first part', { options: { level1_emoji: '👨' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '👨‍👩‍👧 Family' })
  await start($)
  await turn($, 't0')
  await clock.advance(11 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['👨 👨‍👩‍👧 Family', '👨‍👩‍👧 Family'])
})

test('a rename by the person while marked stands', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  w.title('New name')
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a double session.start leaves one timer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await start($)
  await clock.advance(11 * MIN)
  expect(w.attempts).toBe(1)
  w.failRenames = 100 // the wake keeps failing: each tick tries it once
  await turn($, 't1')
  expect(w.attempts).toBe(2)
  await clock.advance(3 * MIN)
  expect(w.attempts).toBe(5) // two timers would make it 8
})

test('a truncated last row and CRLF lines', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.text = w.text.replace(/\n/g, '\r\n') + '{"type":"custom-title","customTi'
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a transcript not found is searched for at most every 10 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', path: `${CONFIG}/projects/-nowhere/x.jsonl` })
  await start($)
  await clock.advance(40 * MIN)
  expect(w.renames).toEqual([])
  expect(w.lists).toBeLessThanOrEqual(5) // at the start, then at 10, 20, 30 and 40 minutes
})

test('the mark is rebuilt from the name under it when the style changes', { options: { brackets: '[]' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 - Builder' }) // set by this mod under another style
  preset(w, ID, '💤 - Builder', 'Builder')
  await start($)
  await clock.advance(3 * HOUR + MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder', '[💤] Builder', '[💤💤] Builder', 'Builder']) // never "[💤] 💤 - Builder"
})

test('a mark set under another style comes off', { options: { position: 'end' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '(💤💤) | Builder' })
  preset(w, ID, '(💤💤) | Builder', 'Builder')
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
})

test('a mark typed by hand is read as a mark: marks never stack', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  await start($)
  expect(w.renames).toEqual(['Builder'])
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['Builder', '💤 Builder'])
})

test('a headless turn clears a mark but never sets one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  preset(w, ID, '💤 Builder', 'Builder')
  await start($, false)
  await turn($, 't1')
  await clock.advance(30 * MIN)
  expect(w.renames).toEqual(['Builder'])
})

test('switching sessions reads the new one', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await turn($, 't1')
  w.id = 'bbbbbbbb-0000-4000-8000-000000000002'
  w.title('💤 Other')
  preset(w, w.id, '💤 Other', 'Other')
  await turn($, 't2')
  expect(w.renames).toEqual(['Other'])
})

test('renamed from the app while marked: once noticed, the new name gets the mark the idle time calls for', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  w.title('New name') // the person renames from the app, without sending anything
  await clock.advance(MIN) // the next check reads the name and marks it as the idle time calls for
  expect(w.renames).toEqual(['💤 Builder', '💤 New name'])
  await clock.advance(2 * HOUR + 50 * MIN)
  expect(w.renames).toEqual(['💤 Builder', '💤 New name', '💤💤 New name'])
  await turn($, 't1')
  expect(w.renames.at(-1)).toBe('New name')
})

test('a session that starts marked, with no saved activity, is woken at once, without a turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤 Builder' })
  preset(w, ID, '💤💤 Builder', 'Builder')
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual(['Builder'])
  expect(marks(w)).toEqual([])
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
})

test('a restart goes on counting from the transcript\'s last activity: 4 hours idle gives 💤💤 at once', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Builder' })
  w.row(96 * HOUR)
  await start($)
  expect(w.renames).toEqual(['💤💤 Builder'])
  await clock.advance(9 * HOUR) // 13 hours in all
  expect(w.renames).toEqual(['💤💤 Builder', '💤💤💤 Builder'])
  await turn($, 't1')
  expect(w.renames.at(-1)).toBe('Builder')
})

test('a resume\'s synthetic reply is not activity: the restart shows the level the real idle time calls for', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Builder' })
  w.row(96 * HOUR)
  // what --continue writes at the restart
  w.text += JSON.stringify({ type: 'assistant', timestamp: new Date(100 * HOUR - 1000).toISOString(), isApiErrorMessage: false, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } }) + '\n'
  await start($)
  expect(w.renames).toEqual(['💤💤 Builder'])
  expect(lastActivityIn(w.text)).toBe(96 * HOUR)
  await clock.advance(2 * MIN) // the ticks that read the transcript again keep the level
  expect(w.renames).toEqual(['💤💤 Builder'])
})

test('a restart of a marked session sets the level the idle time calls for, up or down', async ($, on) => {
  mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: '💤 Builder' })
  w.row(87 * HOUR, 'assistant') // 13 hours
  await start($)
  expect(w.renames).toEqual(['💤💤💤 Builder'])
})

test('a reload while marked keeps the mark: the rename\'s own transcript row is not activity', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Atlas' })
  w.row(100 * HOUR)
  w.metaAt = 100 * HOUR + 11 * MIN
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Atlas'])
  await clock.advance(7 * MIN)
  await start($) // the reload
  await clock.advance(MIN)
  expect(w.renames).toEqual(['💤 Atlas'])
  await clock.advance(3 * HOUR)
  expect(w.renames).toEqual(['💤 Atlas', '💤💤 Atlas'])
})

test('a restart soon after activity: no mark yet, and the next comes when the idle time is due', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: '💤 Builder' })
  w.row(100 * HOUR - 5 * MIN)
  await start($)
  expect(w.renames).toEqual(['Builder'])
  await clock.advance(4 * MIN)
  expect(w.renames).toEqual(['Builder'])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['Builder', '💤 Builder'])
})

test('renames and bookkeeping rows are not activity; a prompt row is', async () => {
  const at = (ms: number, type: string, extra = {}) => JSON.stringify({ type, timestamp: new Date(ms).toISOString(), ...extra })
  const text = [at(1000, 'user'), at(2000, 'assistant'), at(3000, 'system', { subtype: 'local_command' }), at(4000, 'attachment'),
    JSON.stringify({ type: 'custom-title', customTitle: 'x' }), '{"type":"user","timest'].join('\n')
  expect(lastActivityIn(text)).toBe(2000)
  // the row Claude Code adds after each rename, as it is in a real transcript
  const meta = JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'plugin', name: 'nametag' }, message: { content: '<system-reminder>\nThe user named this session "💤 Atlas"' }, timestamp: new Date(9000).toISOString() })
  const typed = JSON.stringify({ type: 'user', isMeta: true, message: { content: '<system-reminder>\nThe user named this session "Atlas"' }, timestamp: new Date(9500).toISOString() })
  expect(lastActivityIn([at(2000, 'assistant'), meta, typed].join('\n'))).toBe(2000)
  expect(lastActivityIn('{"type":"custom-title","customTitle":"x"}')).toBe(null)
})

test('leaving is not activity: a typed /exit or /quit and what it prints', async () => {
  const at = (ms: number, type: string, extra = {}) => JSON.stringify({ type, timestamp: new Date(ms).toISOString(), ...extra })
  const user = (ms: number, content: unknown, extra = {}) => at(ms, 'user', { message: { role: 'user', content }, ...extra })
  const caveat = user(5000, '<local-command-caveat>Caveat: ...</local-command-caveat>', { isMeta: true })
  const exit = user(5001, '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>')
  const bye = user(5002, '<local-command-stdout>See ya!</local-command-stdout>')
  expect(lastActivityIn([at(2000, 'assistant'), caveat, exit, bye].join('\n'))).toBe(2000)
  const quit = user(5001, [{ type: 'text', text: '<command-name>/quit</command-name>' }])
  expect(lastActivityIn([at(2000, 'assistant'), quit].join('\n'))).toBe(2000)
  // a prompt that only mentions it is activity
  expect(lastActivityIn([at(2000, 'assistant'), user(6000, 'how do I /exit vim?')].join('\n'))).toBe(6000)
  expect(lastActivityIn([at(2000, 'assistant'), user(6000, '<command-name>/exits</command-name>')].join('\n'))).toBe(6000)
})

test('a reload in the middle of a long turn does not mark it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await clock.advance(20 * MIN)
  await start($) // the reload, 20 minutes into the turn
  expect(w.renames).toEqual([])
})

test('a reload reads the last activity from the transcript, so the idle time runs on', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await turn($, 't1')
  w.row(1_000_000) // that turn, as the transcript holds it
  await clock.advance(9 * MIN)
  await start($) // the reload: not activity
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a session renamed while it was closed keeps that name at start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  preset(w, ID, '💤 Builder', 'Builder')
  w.title('Fresh name') // e.g. resumed with --name
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual([])
  expect(marks(w)).toEqual([])
})

// ---- work in the background ----

async function background($: any, w: any, tool: string, result: unknown, input: Record<string, unknown> = {}) {
  w.results[tool] = result
  await $.tool.call({ tool, ...input })
}

async function notice($: any, text: string) {
  await $.prompt.submit({ text, origin: { kind: 'task-notification' } } as any)
}

test('a background command keeps the session awake until its end is noticed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1x9' }, { command: 'make', run_in_background: true })
  await clock.advance(2 * HOUR)
  expect(w.renames).toEqual([])
  await notice($, '<task-notification><task-id>b1x9</task-id><status>completed</status></task-notification>')
  await clock.advance(9 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a notice for another task leaves the command counted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1x9' }, { command: 'make', run_in_background: true })
  await notice($, '<task-id>zz77</task-id>')
  await clock.advance(HOUR)
  expect(w.renames).toEqual([])
})

test('a stopped command stops counting', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1x9' }, { command: 'make', run_in_background: true })
  await background($, w, 'TaskStop', { message: 'stopped', task_id: 'b1x9', task_type: 'local_bash' }, { task_id: 'b1x9' })
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a command whose end is never noticed stops counting after a day', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1x9' }, { command: 'make', run_in_background: true })
  await clock.advance(24 * HOUR)
  expect(w.renames).toEqual([])
  await clock.advance(12 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a background workflow counts; a Monitor and a command ended with the reply do not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Monitor', { taskId: 'm1', timeoutMs: 0, persistent: true }, { command: 'tail -f log' })
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2', backgroundEndsWithFinalResponse: true }, { command: 'x', run_in_background: true })
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await turn($, 't1')
  await background($, w, 'Workflow', { status: 'async_launched', taskId: 'wf1' }, { script: 'x' })
  await clock.advance(HOUR)
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
  await notice($, 'workflow wf1 completed')
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder', 'Builder', '💤 Builder'])
})

test('a running agent keeps the session awake; an idle teammate does not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.agents = [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'idle' }]
  await start($)
  await clock.advance(HOUR)
  expect(w.renames).toEqual([])
  w.agents = [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'idle' }]
  await clock.advance(9 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('no level due: the tick ends before asking about agents or reading the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  const reads = w.reads
  await clock.advance(9 * MIN)
  expect(w.agentLists).toBe(0)
  expect(w.reads).toBe(reads)
  await clock.advance(2 * MIN)
  expect(w.agentLists).toBeGreaterThan(0)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('the store keeps only recent model-check times; anything else is dropped', async ($, on) => {
  mock.clock(on, { now: 100 * 24 * HOUR })
  const w = world(on, { name: 'Builder' })
  w.store.set('mark:old', { set: 'x', base: 'y', at: 1 })
  w.store.set('seen:x', 99 * 24 * HOUR)
  w.store.set('freeze:x', 101 * 24 * HOUR)
  w.store.set('notopic:x', 99 * 24 * HOUR)
  w.store.set('asked:old', 1)
  w.store.set('asked:new', 99 * 24 * HOUR)
  await start($)
  expect([...w.store.keys()].sort()).toEqual(['asked:new', 'styles'])
})

test('options changed: a mark set under the old ones comes off exactly, not stacked, and the name\'s own emoji stays', { options: { brackets: '()', level1_emoji: '🫪', level2_emoji: '🫪', level3_emoji: '🫪' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  const w = world(on, { name: '(😴🫪) 🚀 Nova' })
  w.row(10 * HOUR - 40 * MIN) // idle 40 minutes: one level (the second is at 3 hours)
  // what the store held from the start before, under the old options
  w.store.set('styles', [{ emojis: ['😴', '🫪', '🫪'], atEnd: false, sep: '', open: '(', close: ')', topic: false, topicSep: '·', topicOpen: '', topicClose: '' }])
  await start($)
  expect(w.renames).toEqual(['(🫪) 🚀 Nova'])
  expect((w.store.get('styles') as any[]).map(x => x.emojis.join(''))).toEqual(['🫪🫪🫪', '😴🫪🫪'])
  await clock.advance(MIN)
  expect(w.renames).toEqual(['(🫪) 🚀 Nova'])
})

test('options changed: a name the person gave, starting with an emoji, under a mark of the old options', { options: { level1_emoji: '😴' } }, async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world(on, { name: '🫪 🤖 Robo' })
  w.row(10 * HOUR - 11 * MIN)
  w.store.set('styles', [{ emojis: ['🫪', '🫪', '🫪'], atEnd: false, sep: '', open: '', close: '', topic: false, topicSep: '·', topicOpen: '', topicClose: '' }])
  await start($)
  expect(w.renames).toEqual(['😴 🤖 Robo'])
})

test('a name taken apart by the options used before, when the current ones find no mark', async () => {
  const st = style({ level1_emoji: '😴' })
  expect(decompose('(😴🫪) 🚀 Nova', style({ brackets: '()', level1_emoji: '🫪', level2_emoji: '🫪' }), [style({ brackets: '()', level1_emoji: '😴', level2_emoji: '🫪' })]))
    .toEqual({ base: '🚀 Nova', level: 2, topic: null })
  expect(decompose('😴 Builder', st, [])).toEqual({ base: 'Builder', level: 1, topic: null })
})

test('the person\'s /rename while marked: their name stands, and is not activity: the mark the idle time calls for comes back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await $.prompt.submit({ text: '/rename New name' } as any) // should a typed command come this way too
  await personRename($, 'New name')
  expect(w.renames).toEqual(['💤 Builder', 'New name'])
  await clock.advance(MIN)
  expect(w.renames).toEqual(['💤 Builder', 'New name', '💤 New name'])
})

test('the wake file: the marked name and the hook\'s answer while marked, emptied when awake', { options: { topic: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder [alpha]' })
  const path = `${CONFIG}/nametag/wake/${ID}`
  await start($)
  expect(w.files.has(path)).toBe(false) // never marked: no file
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder [alpha]'])
  expect(w.files.get(path)).toBe(`"💤 Builder [alpha]"\n{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"Builder [alpha]"}}\n`)
  await turn($, 't1')
  expect(w.files.get(path)).toBe('')
})

test('the person\'s /rename runs while the mod\'s waits in the queue: theirs stands', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  let open = () => {}
  w.gate = new Promise<void>(r => { open = r })
  await turn($, 't1') // the wake's rename now waits its turn
  await personRename($, 'Foo') // the person's, typed earlier, runs first
  w.gate = undefined
  open()
  await settle()
  expect(w.renames).toEqual(['💤 Builder', 'Foo', 'Builder', 'Foo'])
  expect(w.store.has(`mark:${ID}`)).toBe(false)
  await clock.advance(11 * MIN)
  expect(w.renames.at(-1)).toBe('💤 Foo')
})

test('a wake that fails is tried again by the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  w.failRenames = 1
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(MIN)
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
})

test('a hot reload during a turn: the turn still counts as running', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  w.row(1_000_000)
  await start($) // the reload
  await clock.advance(30 * MIN)
  expect(w.renames).toEqual([])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

// The row Claude Code writes when a turn of the main conversation ends.
function turnEnd(w: any, ms: number) {
  w.text += JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: new Date(ms).toISOString() }) + '\n'
}

test('a hot reload during a turn whose end the new load never hears: the transcript ends it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  w.row(1_000_000)
  await start($) // the reload; the engine sends this turn's end to no hook of the new load
  w.row(1_000_000 + 10_000, 'assistant')
  turnEnd(w, 1_000_000 + 15_000)
  await clock.advance(9 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await turn($, 't2') // the next turn is heard whole again
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
})

test('a turn a reload cut into, with no end in the transcript, is over after an hour of silence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  w.row(1_000_000)
  await start($)
  await clock.advance(59 * MIN)
  expect(w.renames).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.renames).toEqual(['💤 Builder']) // the levels due by the time since the prompt
})

test('a turn a reload cut into runs on while the transcript shows no activity to judge by', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await start($) // its prompt not in the transcript (yet, or past the part read)
  await clock.advance(30 * MIN)
  expect(w.renames).toEqual([])
  w.row(1_000_000)
  turnEnd(w, 1_000_000 + 31 * MIN)
  await clock.advance(MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a turn this load heard start is not ended by the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  turnEnd(w, 1_000_000) // an earlier turn's end, say
  await clock.advance(90 * MIN) // a long turn: no mark while it runs
  expect(w.renames).toEqual([])
})

test('the summary of a compaction while idle is not activity', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.row(1_000_000)
  turnEnd(w, 1_000_000)
  await start($)
  await clock.advance(5 * MIN)
  w.text += JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: new Date(1_000_000 + 5 * MIN).toISOString(), message: { content: 'summary' } }) + '\n'
  await clock.advance(6 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('turnEndedIn: the newest turn row decides; subagent rows do not', () => {
  const at = '"timestamp":"2026-01-01T00:00:00.000Z"'
  const prompt = `{"type":"user",${at},"message":{"content":"x"}}`
  const end = `{"type":"system","subtype":"turn_duration",${at}}`
  const side = `{"type":"assistant","isSidechain":true,${at},"message":{"content":"x"}}`
  const meta = `{"type":"user","isMeta":true,${at},"message":{"content":"x"}}`
  expect(turnEndedIn([prompt, end].join('\n'))).toBe(true)
  expect(turnEndedIn([end, prompt].join('\n'))).toBe(false)
  expect(turnEndedIn([prompt, end, side, meta].join('\n'))).toBe(true)
  expect(turnEndedIn('')).toBe(false)
})

test('another session dropping this one\'s record from the shared store: the mark still comes off', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  w.store.delete(`mark:${ID}`)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
})

test('a notice ends only the task it names, as a whole word', async () => {
  expect(mentions('<task-id>b1</task-id> done', 'b1')).toBe(true)
  expect(mentions('<task-id>b12</task-id> done', 'b1')).toBe(false)
  expect(mentions('task a.b+c ended', 'a.b+c')).toBe(true)
})

test('background tasks from the conversation: started since this process, less those with an end notice', async () => {
  const bash = (id: string) => ({ tool: 'Bash', result: { backgroundTaskId: id } })
  const msgs = [
    { role: 'assistant', text: '', toolUses: [bash('old')] }, // before this process: died with the last one
    { role: 'assistant', text: '', toolUses: [bash('b1'), bash('b2'), { tool: 'Workflow', result: { status: 'async_launched', taskId: 'w1' } }] },
    { role: 'user', text: '<task-notification><task-id>b1</task-id></task-notification>' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'TaskStop', result: { task_id: 'w1' } }] },
  ]
  expect([...runningTasks(msgs, 1)]).toEqual(['b2'])
})

// ---- the topic ----

const TOPIC = { topic: 'on' } as const

// A workspace root: /work/demo holds projects of its own.
function workspace(w: any) {
  w.dirs['/work/demo'] = ['alpha', 'beta', '.cache']
  w.git.add('/work/demo/alpha/.git')
}

// A tool call with a path, as the conversation holds it.
async function edit(_$: any, path: string, tool = 'Edit') {
  const field = tool === 'Grep' || tool === 'Glob' ? 'path' : 'file_path'
  current.messages.push({ role: 'assistant', text: '', toolUses: [{ tool, input: { [field]: path } }] })
}

async function turns($: any, clock: any, n: number, from = 0) {
  for (let i = 0; i < n; i++) await turn($, `t${from + i}`)
  await clock.advance(MIN) // lets the unawaited topic check finish
}

test('topic: a project that leads the edited paths names it, no model call', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/src/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder [alpha]'])
  expect(w.asks).toBe(0)
  await clock.advance(11 * MIN)
  expect(w.renames.at(-1)).toBe('💤 Builder [alpha]')
  await turn($, 'x1')
  expect(w.renames.at(-1)).toBe('Builder [alpha]')
})

test('topic: no clear project, so the model is asked; its answer is cleaned', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [
    { role: 'user', text: 'compare the two hosting plans' },
    { role: 'assistant', text: 'Plan A costs less.' },
    { role: 'user', text: '<command-name>/rename</command-name>' },
  ]
  w.answers = ['"Hosting Plans!"']
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1)
  expect(w.prompts[0]).toContain('User: compare the two hosting plans')
  expect(w.prompts[0]).not.toContain('/rename')
  expect(w.renames).toEqual(['Builder [Hosting]']) // one word by default
})

test('topic: fewer than 3 prompts, no model call', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.answers = ['greeting']
  await start($)
  await turns($, clock, 2)
  expect(w.asks).toBe(0)
  await turns($, clock, 1, 2)
  expect(w.asks).toBe(1)
})

test('topic: SAME keeps it; the model is asked at most every 10 minutes', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'SAME', 'SAME']
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1)
  expect(w.renames).toEqual(['Builder [billing]'])
  await clock.advance(5 * MIN)
  await turns($, clock, 3, 10) // within 10 minutes: no check
  expect(w.asks).toBe(1)
  await clock.advance(5 * MIN)
  await turns($, clock, 1, 20)
  expect(w.asks).toBe(2)
  expect(w.prompts[1]).toContain('Current topic: billing')
  expect(w.prompts[1]).toContain('The goal: a short topic')
  expect(w.renames.filter(r => !r.endsWith('[billing]'))).toEqual([])
})

test('topic: an idle restart with a topic in the name asks no model', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Builder [billing]' })
  w.row(99 * HOUR) // an hour idle
  w.messages = [{ role: 'user', text: 'fix the billing bug' }, { role: 'user', text: 'and the invoices' }, { role: 'user', text: 'and the tax' }]
  w.answers = ['tax']
  await start($)
  await clock.advance(MIN)
  expect(w.asks).toBe(0)
  expect(w.renames).toEqual(['💤 Builder [billing]'])
})

test('topic: an idle restart without a topic asks the model, at low effort with room to think', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Builder' })
  w.row(99 * HOUR)
  w.messages = [{ role: 'user', text: 'fix the billing bug' }, { role: 'user', text: 'and the invoices' }, { role: 'user', text: 'and the tax' }]
  w.answers = ['billing']
  await start($)
  await clock.advance(MIN)
  expect(w.asks).toBe(1)
  expect(w.calls).toEqual([{ effort: 'low', maxTokens: 1000 }])
  expect(w.renames.at(-1)).toBe('💤 Builder [billing]')
})

test('topic: a restart keeps the 10-minute cap on model calls', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }, { role: 'user', text: 'and the invoices' }, { role: 'user', text: 'and the tax' }]
  w.answers = ['billing', 'invoices']
  await start($)
  await clock.advance(MIN)
  expect(w.asks).toBe(1) // checked at the start, from the conversation as it stands
  await start($) // the restart
  await turns($, clock, 2)
  expect(w.asks).toBe(1)
})

test('topic: a new answer after 10 minutes renames, asleep or awake', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'invoices']
  await start($)
  await turns($, clock, 3)
  await clock.advance(40 * MIN) // asleep
  expect(w.renames).toEqual(['Builder [billing]', '💤 Builder [billing]'])
  await turns($, clock, 3, 10)
  expect(w.asks).toBe(2)
  expect(w.renames).toEqual(['Builder [billing]', '💤 Builder [billing]', 'Builder [billing]', 'Builder [invoices]'])
})

// Busy turns 8 minutes apart (never 10 idle minutes), for `minutes` in all.
async function busyFor($: any, clock: any, minutes: number, tag: string) {
  for (let i = 0; i < Math.ceil(minutes / 8); i++) { await clock.advance(8 * MIN); await turn($, `${tag}${i}`) }
  await clock.advance(1)
}

test('topic: a check that finds nothing waits longer each time: 10, 20, 40 minutes', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1) // failed: 20 minutes now
  await busyFor($, clock, 16, 'a')
  expect(w.asks).toBe(1)
  await busyFor($, clock, 8, 'b')
  expect(w.asks).toBe(2) // failed again: 40 minutes now
  await busyFor($, clock, 32, 'c')
  expect(w.asks).toBe(2)
  w.answers = ['billing']
  await busyFor($, clock, 16, 'd')
  expect(w.asks).toBe(3)
  expect(w.renames).toEqual(['Builder [billing]'])
})

test('topic: a model that only gives the name back counts as a miss', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Billing' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'billing', 'billing']
  await start($)
  await turns($, clock, 3)
  await busyFor($, clock, 16, 'a')
  expect(w.asks).toBe(1) // a miss: 20 minutes, not 10
  expect(w.renames).toEqual([])
})

test('topic: renamed from the app (no /rename), the next check builds on the new name', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 1)
  expect(w.renames).toEqual(['Builder [alpha]'])
  w.title('Shipping')
  await turns($, clock, 1, 10)
  expect(w.renames).toEqual(['Builder [alpha]', 'Shipping [alpha]'])
})

test('topic: a search of the whole session folder says nothing', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.git.add('/work/demo/.git')
  w.messages = [{ role: 'user', text: 'hi' }]
  await start($)
  for (let i = 0; i < 6; i++) await edit($, '/work/demo', 'Grep')
  await turns($, clock, 3)
  expect(w.renames).toEqual([])
  expect(w.asks).toBe(1) // no project, so the model was asked (and had no answer)
})

test('topic: a topic the name already says is left off', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Alpha work' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual([])
})

test('topic: a long folder name gives its last word, or two with topic_words: 2', { options: { topic: 'on', topic_words: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.dirs['/work/demo'] = ['cc-mod-billing-api']
  w.git.add('/work/demo/cc-mod-billing-api/.git')
  await start($)
  await edit($, '/work/demo/cc-mod-billing-api/a.ts')
  await edit($, '/work/demo/cc-mod-billing-api/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder [billing-api]'])
})

test('topic: one word by default: a folder gives its longest', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.dirs['/work/demo'] = ['cc-mod-nametag']
  w.git.add('/work/demo/cc-mod-nametag/.git')
  await start($)
  await edit($, '/work/demo/cc-mod-nametag/a.ts')
  await edit($, '/work/demo/cc-mod-nametag/b.ts')
  await turns($, clock, 1)
  expect(w.renames).toEqual(['Builder [nametag]'])
})

test('topic: a dot folder is no project', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  w.messages = [{ role: 'user', text: 'hi' }]
  w.answers = ['setup']
  await start($)
  await edit($, '/work/demo/.cache/a.ts')
  await edit($, '/work/demo/.cache/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder [setup]'])
})

test('topic: the person renames it, and the topic goes on their new name', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 1)
  expect(w.renames).toEqual(['Builder [alpha]'])
  await personRename($, 'Shipping')
  await turns($, clock, 1, 10)
  expect(w.renames).toEqual(['Builder [alpha]', 'Shipping', 'Shipping [alpha]'])
})

test('topic: /topic off takes it off for this session, /topic on brings it back', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 1)
  expect(w.renames).toEqual(['Builder [alpha]'])
  await $.command.run({ command: 'topic', args: 'off', origin: { kind: 'composer' } })
  await settle()
  expect(w.renames.at(-1)).toBe('Builder')
  await turns($, clock, 2, 10)
  expect(w.renames.at(-1)).toBe('Builder')
  await clock.advance(11 * MIN)
  expect(w.renames.at(-1)).toBe('💤 Builder') // the mark still works
  await $.command.run({ command: 'topic', args: 'on', origin: { kind: 'composer' } })
  await clock.advance(MIN)
  expect(w.renames.at(-1)).toBe('💤 Builder [alpha]')
})

test('topic: a session restarted with a topic keeps it', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder [alpha]' })
  w.store.set(`mark:${ID}`, { set: 'Builder [alpha]', base: 'Builder', at: 1, level: 0, topic: 'alpha' })
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual([])
  await clock.advance(10 * MIN)
  expect(w.renames).toEqual(['💤 Builder [alpha]'])
})

test('topic: turned off, a bracketed end is part of the name', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder [alpha]' })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder [alpha]'])
})

test('the name taken apart: mark, topic, and a mark of another style', async () => {
  const st = style({ topic: 'on', level2_emoji: '🐑' })
  expect(decompose('💤🐑 Builder [alpha]', st)).toEqual({ base: 'Builder', level: 2, topic: 'alpha' })
  expect(decompose('🛰️ Atlas 😑', st)).toEqual({ base: '🛰️ Atlas 😑', level: 0, topic: null })
  expect(decompose('(💤) - Builder', st)).toEqual({ base: 'Builder', level: 1, topic: null })
  expect(decompose('Builder | 💤💤', st)).toEqual({ base: 'Builder', level: 1, topic: null })
  expect(decompose('💤 My notes', st).base).toBe('My notes')
  expect(decompose('Builder [alpha]', style({})).topic).toBe(null)
  // an emoji after a mark of another style is the name's own, not a separator
  const now = style({ level1_emoji: '😴', level2_emoji: '🫪', level3_emoji: '🫪' })
  expect(decompose('🫪 🤖 Robo 😒', now)).toEqual({ base: '🤖 Robo 😒', level: 1, topic: null })
  expect(decompose('🫪 🛰️ Atlas', now)).toEqual({ base: '🛰️ Atlas', level: 1, topic: null })
  expect(decompose('🫪 · Atlas', now)).toEqual({ base: 'Atlas', level: 1, topic: null })
  expect(decompose('Atlas 🤖 🫪', now)).toEqual({ base: 'Atlas 🤖', level: 1, topic: null })
})

test('/topic off or on: the last such command in the transcript', async () => {
  const row = (a: string) => JSON.stringify({ type: 'system', content: `<command-name>/topic</command-name>\n<command-args>${a}</command-args>` })
  expect(lastTopicCommand([row('off'), row('on'), row('off')].join('\n'))).toBe(true)
  expect(lastTopicCommand(row('on'))).toBe(false)
  expect(lastTopicCommand('nothing')).toBe(null)
})

test('topic: off by default, no path noted and no model call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  w.answers = ['x']
  w.messages = [{ role: 'user', text: 'hi' }]
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await turns($, clock, 5)
  expect(w.asks).toBe(0)
  expect(w.lists).toBe(0)
  expect(w.renames).toEqual([])
})

test('topic: paths outside the root count by their repository; separator and bracket options', { options: { topic: 'on', topic_separator: '|' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.git.add('/opt/render/.git')
  await start($)
  await edit($, '/opt/render/server.py')
  await edit($, '/opt/render/lib/x.py', 'Write')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder | [render]'])
})

test('topic: scattered paths lead nowhere, so the model decides', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  w.messages = [{ role: 'user', text: 'tidy up' }]
  w.answers = ['cleanup']
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/beta/b.ts')
  await edit($, '/home/u/notes.md')
  await turns($, clock, 3)
  expect(w.asks).toBe(1)
  expect(w.renames).toEqual(['Builder [cleanup]'])
})


test('topic: brackets off and a separator', { options: { topic: 'on', topic_brackets: 'none', topic_separator: '·' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder · alpha'])
})

test('topic: an unnamed session is left alone, with no model call', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.messages = [{ role: 'user', text: 'hi' }]
  w.answers = ['greeting']
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(0)
  expect(w.renames).toEqual([])
})

test('topic: the paths are checked every turn, from the first, with no model call', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  w.dirs['/work/demo'] = ['alpha', 'beta']
  w.git.add('/work/demo/beta/.git')
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 1)
  expect(w.renames).toEqual(['Builder [alpha]'])
  await turns($, clock, 1, 1) // the same project: nothing to rename
  expect(w.renames).toEqual(['Builder [alpha]'])
  await clock.advance(20 * MIN) // asleep; alpha's weight halves twice (6 to 1.5)
  for (let i = 0; i < 3; i++) await edit($, `/work/demo/beta/${i}.ts`)
  await turns($, clock, 1, 2)
  expect(w.renames).toEqual(['Builder [alpha]', '💤 Builder [alpha]', 'Builder [alpha]', 'Builder [beta]'])
  expect(w.asks).toBe(0)
})

test('topic: the person renames during the model call: the topic lands on their new name', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }, { role: 'user', text: 'and the invoices' }]
  w.answers = ['billing']
  let open = () => {}
  w.modelGate = new Promise<void>(r => { open = r })
  await start($)
  await turn($, 't0') // three prompts: the model is asked, and takes a while
  await personRename($, 'Shipping')
  w.modelGate = undefined
  open()
  await clock.advance(MIN)
  expect(w.asks).toBe(1)
  expect(w.renames).toEqual(['Shipping', 'Shipping [billing]'])
})

test('topic: a model call the engine refuses counts as a miss', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.modelRefuses = true
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1)
  await clock.advance(11 * MIN)
  await turns($, clock, 3, 10)
  expect(w.asks).toBe(1) // a miss: 20 minutes, not 10
  await clock.advance(8 * MIN)
  await turns($, clock, 3, 20)
  expect(w.asks).toBe(2)
  expect(w.renames.filter(r => r.includes('['))).toEqual([])
})

test('topic: the label cleanup', async () => {
  expect(cleanTopic('billing-api', null, 'last', 1)).toBe('billing')
  expect(cleanTopic('cc-mod-nametag', null, 'last', 1)).toBe('nametag')
  expect(cleanTopic('web-shop', null, 'last', 1)).toBe('shop')
  expect(cleanTopic('billing api', null)).toBe('billing-api')
  expect(cleanTopic('  "**Hosting Plans**."\nbecause...', null)).toBe('Hosting-Plans')
  expect(cleanTopic('SAME', 'alpha')).toBe('alpha')
  expect(cleanTopic('same.', null)).toBe(null)
  expect(cleanTopic('a-very-long-label-that-goes-on', null)).toBe('a-very')
  expect(cleanTopic('internationalization-framework', null)).toBe('internationalization')
  expect(cleanTopic('rm -rf / ; echo $HOME', null)).toBe('rm-rf')
  expect(cleanTopic('Lisbon trip planning', null)).toBe('Lisbon-trip')
  expect(cleanTopic('cc-mod-billing-api', null, 'last')).toBe('billing-api')
  expect(cleanTopic('snake_case_name', null)).toBe('snake-case')
  expect(cleanTopic('🙂', null)).toBe(null)
  expect(cleanTopic('café-menu', null)).toBe('café-menu')
})

test('topic: a project leads with 60% of the weight and at least 5', async () => {
  expect(leader({ a: 6, b: 3 }, 9)).toBe('a')
  expect(leader({ a: 4 }, 4)).toBe(null)
  expect(leader({ a: 6, b: 5 }, 11)).toBe(null)
  expect(leader({ a: 6 }, 12)).toBe(null) // half the weight is outside any project
})

test('topic: recent lines skip command and notice rows, 10 prompts and 4 replies at most, 600 characters each', async () => {
  const msgs = [
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `ask ${i} ${'x'.repeat(700)}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ role: 'assistant', text: `reply ${i}` })),
    { role: 'user', text: '<task-notification><task-id>b1</task-id></task-notification>' },
    { role: 'user', text: '' },
  ]
  const lines = recentLines(msgs)
  const users = lines.filter(l => l.startsWith('User:'))
  expect(users.length).toBe(10)
  expect(users[0]).toStartWith('User: ask 2 ')
  expect(users[0].length).toBe('User: '.length + 600)
  expect(lines.filter(l => l.startsWith('Claude:'))).toEqual(['Claude: reply 1', 'Claude: reply 2', 'Claude: reply 3', 'Claude: reply 4'])
  expect(lines.join('\n')).not.toContain('task-notification')
})

// ---- found in the review before going public ------------------------------------------------

test('topic: a model answer with a preamble keeps the topic; SAME with a note keeps the current one', async () => {
  expect(cleanTopic('Topic: billing', null, 'first', 1)).toBe('billing')
  expect(cleanTopic('Label: "billing api"', null, 'first', 2)).toBe('billing-api')
  expect(cleanTopic('SAME (billing)', 'docs', 'first', 1)).toBe('docs')
  expect(cleanTopic('Sameday', 'docs', 'first', 1)).toBe('Sameday')
  expect(cleanTopic('same-origin', 'docs', 'first', 2)).toBe('same-origin')
  expect(cleanTopic('SAME: still fits', 'docs', 'first', 1)).toBe('docs')
  expect(cleanTopic('same-day-api', null, 'last', 1)).toBe('same') // a folder: its longest word
})

test('topic: a repository root with a submodule in it is one project, not a workspace', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.dirs['/work/demo'] = ['src', 'docs', 'vendor']
  w.git.add('/work/demo/.git'); w.git.add('/work/demo/vendor/.git')
  await start($)
  for (let i = 0; i < 3; i++) await edit($, `/work/demo/src/f${i}.ts`)
  await turns($, clock, 2)
  expect(w.renames).toEqual([]) // not "Builder [src]"
})

test('topic: Windows paths give a path topic, with no model call', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.git.add('C:/code/alpha/.git')
  w.answers = ['misc']
  await start($)
  for (let i = 0; i < 6; i++) await edit($, `C:\\code\\alpha\\src\\f${i}.ts`)
  await turns($, clock, 3)
  expect(w.asks).toBe(0)
  expect(w.renames).toEqual(['Builder [alpha]'])
})

test('an end notice the conversation holds ends a background task, even one prompt.submit never saw', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1x9' }, { command: 'make', run_in_background: true })
  w.messages.push({ role: 'user', text: '<task-notification><task-id>b1x9</task-id><status>completed</status></task-notification>' })
  await clock.advance(5 * HOUR)
  expect(w.renames.at(-1)).toBe('💤💤 Builder')
})

// The subagent's own transcript, where its background tasks' end notices go.
function subagentRows(w: any, agent: string, text: string) {
  w.subagents = { ...(w.subagents ?? {}), [agent]: text }
}

test('a subagent\'s background command keeps the session awake until its end notice, in the subagent\'s transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  subagentRows(w, 'a1', '{"type":"user","message":"run make"}\n')
  await start($)
  w.results.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sub1' }
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true, agentId: 'a1' } as any)
  await clock.advance(30 * MIN) // the subagent has ended; its command runs on
  expect(w.renames).toEqual([])
  subagentRows(w, 'a1', '{"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification><task-id>sub1</task-id><status>completed</status></task-notification>"}}\n')
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a subagent\'s background command whose transcript can\'t be read counts while the subagent is at work', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.agents = [{ id: 'a1', status: 'waiting' }] // on its own background work
  await start($)
  w.results.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sub1' }
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true, agentId: 'a1' } as any)
  await clock.advance(30 * MIN)
  expect(w.renames).toEqual([])
  w.agents = [{ id: 'a1', status: 'completed' }]
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('a subagent\'s background command stopped by TaskStop in its loop ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  subagentRows(w, 'a1', '')
  await start($)
  w.results.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sub1' }
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true, agentId: 'a1' } as any)
  w.results.TaskStop = { task_id: 'sub1' }
  await $.tool.call({ tool: 'TaskStop', task_id: 'sub1', agentId: 'a1' } as any)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('topic: turns that end while a rename waits ask the model once, not once each', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  w.messages = [{ role: 'user', text: 'a1' }, { role: 'user', text: 'b2' }, { role: 'user', text: 'c3' }]
  w.answers = ['alpha', 'beta', 'gamma']
  let open: () => void = () => {}
  w.gate = new Promise<void>(r => { open = r })
  await start($)
  await turn($, 'x1')
  await turn($, 'x2')
  open(); w.gate = undefined
  await settle(); await clock.advance(MIN); await settle()
  expect(w.asks).toBe(1)
})

test('after /clear the old session\'s background work and /topic are forgotten', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  await start($)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'old1' }, { command: 'serve', run_in_background: true })
  await $.command.run({ command: 'topic', args: 'off' } as any)
  await $.session.end({ reason: 'clear', sessionId: w.id } as any)
  w.id = 'bbbbbbbb-0000-4000-8000-000000000002'
  w.text = ''
  w.title('Fresh')
  w.messages = []
  w.answers = ['alpha']
  await turns($, clock, 3) // the new session's own prompts: the topic is on again, so the model is asked
  expect(w.renames.at(-1)).toBe('Fresh [alpha]')
  await clock.advance(11 * MIN) // and the old session's background command doesn't keep it awake
  expect(w.renames.at(-1)).toBe('💤 Fresh [alpha]')
})

test('after /clear, work the first turn puts in the background keeps the new session awake', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  await start($)
  await $.session.end({ reason: 'clear', sessionId: w.id } as any)
  w.id = 'bbbbbbbb-0000-4000-8000-000000000002'
  w.text = ''
  w.title('Fresh')
  w.messages = []
  await $.prompt.submit({ text: 'start the server' } as any)
  await $.turn.start({ text: 'start the server', turnId: 'n1' } as any)
  await background($, w, 'Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'new1' }, { command: 'serve', run_in_background: true })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'n1', reason: 'answer' } as any)
  await settle()
  await clock.advance(30 * MIN)
  expect(w.renames.filter(r => r.includes('💤'))).toEqual([])
})

test('a resume in the same process: the resumed session\'s old background tasks died with their process', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  await start($)
  await $.session.end({ reason: 'resume', sessionId: w.id } as any)
  w.id = 'bbbbbbbb-0000-4000-8000-000000000002'
  w.text = ''
  w.title('Older')
  w.row(1_000_000 - HOUR)
  w.messages = [
    { role: 'user', text: 'run it' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'serve', run_in_background: true }, result: { backgroundTaskId: 'gone1' } }] },
  ]
  await clock.advance(2 * MIN)
  expect(w.renames.at(-1)).toBe('💤 Older')
})

test('an idle session whose transcript has not changed is not read again until a new level is due', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  const reads = w.reads
  await clock.advance(60 * MIN)
  expect(w.reads).toBe(reads)
  w.title('Other') // a rename from the app changes the transcript
  await clock.advance(MIN)
  expect(w.renames.at(-1)).toBe('💤 Other')
  await clock.advance(3 * HOUR)
  expect(w.renames.at(-1)).toBe('💤💤 Other')
})

const bridgeUp = (ms: number) => JSON.stringify({ type: 'system', subtype: 'bridge_status', content: '/remote-control is active', timestamp: new Date(ms).toISOString() })
const renamed = (ms: number, name = 'x') => JSON.stringify({ type: 'system', subtype: 'local_command', content: `<command-name>/rename</command-name>\n            <command-args>${name}</command-args>`, timestamp: new Date(ms).toISOString() })

test('bridgeBehind: a connect with no rename after it', () => {
  expect(bridgeBehind([renamed(1), bridgeUp(2)].join('\n'))).toBe(true) // the start: rename, then the bridge
  expect(bridgeBehind([bridgeUp(1), renamed(2)].join('\n'))).toBe(false) // renamed while connected
  expect(bridgeBehind([renamed(1), bridgeUp(2), renamed(3)].join('\n'))).toBe(false) // sent again
  expect(bridgeBehind([bridgeUp(1), renamed(2), bridgeUp(3), renamed(4), bridgeUp(5)].join('\n'))).toBe(true)
  // a connect doesn't send the name: a restart with nothing to rename, connected again
  expect(bridgeBehind([renamed(1), bridgeUp(2), bridgeUp(3)].join('\n'))).toBe(true)
  expect(bridgeBehind(bridgeUp(1))).toBe(true) // the rename out of reach: the name is sent anyway
  expect(bridgeBehind(renamed(1))).toBe(false) // no Remote Control
  // a /topic or other local command is not a rename, nor a subagent's row
  const topic = JSON.stringify({ type: 'system', subtype: 'local_command', content: '<command-name>/topic</command-name> /rename', timestamp: new Date(1).toISOString() })
  expect(bridgeBehind([renamed(1), bridgeUp(2), topic].join('\n'))).toBe(true)
  const side = JSON.stringify({ type: 'system', subtype: 'bridge_status', isSidechain: true, content: 'x' })
  expect(bridgeBehind([renamed(1), side].join('\n'))).toBe(false)
})

test('Remote Control that connects after the start rename gets the name once more', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: '💤 Builder' })
  w.localAt = 100 * HOUR
  w.row(100 * HOUR - 5 * MIN)
  await start($)
  expect(w.renames).toEqual(['Builder'])
  w.text += bridgeUp(100 * HOUR + 1000) + '\n'
  await clock.advance(1 * MIN)
  expect(w.renames).toEqual(['Builder', 'Builder'])
  await clock.advance(3 * MIN)
  expect(w.renames).toEqual(['Builder', 'Builder'])
  // then the levels as usual
  await clock.advance(3 * MIN)
  expect(w.renames).toEqual(['Builder', 'Builder', '💤 Builder'])
})

test('no Remote Control, or a rename after it connected: nothing sent again', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: '💤 Builder' })
  w.localAt = 100 * HOUR
  w.text += bridgeUp(100 * HOUR - 10 * MIN) + '\n'
  w.row(100 * HOUR - 5 * MIN)
  await start($) // its rename comes after the connect
  await clock.advance(4 * MIN)
  expect(w.renames).toEqual(['Builder'])
})

test('a restart with nothing to rename: the name is sent once after Remote Control connects', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * HOUR })
  const w = world(on, { name: 'Builder' })
  w.localAt = 100 * HOUR
  w.text += renamed(100 * HOUR - 20 * MIN, 'Builder') + '\n' + bridgeUp(100 * HOUR - 20 * MIN + 600) + '\n'
  w.row(100 * HOUR - 5 * MIN)
  await start($)
  expect(w.renames).toEqual([])
  w.text += bridgeUp(100 * HOUR + 1000) + '\n'
  await clock.advance(1 * MIN)
  expect(w.renames).toEqual(['Builder'])
  await clock.advance(3 * MIN)
  expect(w.renames).toEqual(['Builder'])
})
