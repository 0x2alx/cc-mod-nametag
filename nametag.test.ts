import { expect, mock, test } from 'claude-code/testing'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONFIG = '/u/.claude'
const PATH = `${CONFIG}/projects/-work-demo/${ID}.jsonl`
const PROJECTS = ['-other-project', '-work-demo']
const MIN = 60 * 1000
const HOUR = 60 * MIN

// A fake world beneath the mod: one transcript, /rename appending a title row to it.
function world(on: any, opts: { name?: string; size?: number; env?: Record<string, string>; path?: string } = {}) {
  const path = opts.path ?? PATH
  const w = { text: '{"type":"user","message":"hello"}\n', renames: [] as string[], greps: 0, reads: 0, blocked: false }
  const title = (name: string) => { w.text += JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: ID }) + '\n' }
  if (opts.name !== undefined) title(opts.name)
  mock.env(on, opts.env ?? { CLAUDE_CONFIG_DIR: CONFIG })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (e.path !== path || w.blocked) throw new Error('ENOENT')
    return { value: { kind: 'file', size: opts.size ?? w.text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path !== path) throw new Error('ENOENT')
    w.reads++
    return { value: w.text }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === path }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    if (e.path !== `${CONFIG}/projects`) throw new Error('ENOENT')
    return { value: [...PROJECTS, path.split('/').at(-2)].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    w.greps++
    const hits = w.text.split('\n').filter(l => l.includes('"type":"custom-title"'))
    return { value: { exitCode: hits.length ? 0 : 1, stdout: hits.join('\n'), stderr: '' } }
  })
  on('command.run', (_: unknown, e: { command: string; args: string }) => {
    if (e.command === 'rename') { w.renames.push(e.args); title(e.args) }
    return { text: `Session renamed to: ${e.args}` }
  })
  return w
}

async function start($: any, isInteractive = true) {
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive })
}

async function turn($: any, id: string) {
  await $.turn.start({ text: 'hi', turnId: id } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' } as any)
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

test('a transcript over 4 MiB is searched with grep', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Big one', size: 20 * 1024 * 1024 })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Big one'])
  expect(w.greps).toBeGreaterThan(0)
  expect(w.reads).toBe(0)
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

test('wakes a name marked by an older version', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤💤 Builder' })
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
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

test('a new style still wakes a name marked the old way', { options: { position: 'end', separator: '-' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤💤 Builder' })
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
})

test('a name ending in an unmarked emoji is left alone', { options: { position: 'end' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder 😑' })
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual([])
})
