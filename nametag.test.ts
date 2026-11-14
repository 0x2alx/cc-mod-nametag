import { expect, mock, test } from 'claude-code/testing'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONFIG = '/u/.claude'
const PATH = `${CONFIG}/projects/-work-demo/${ID}.jsonl`
const MIN = 60 * 1000

// A fake world beneath the mod: one transcript, /rename appending a title row to it.
function world(on: any, opts: { name?: string; size?: number; env?: Record<string, string> } = {}) {
  const w = { text: '{"type":"user","message":"hello"}\n', renames: [] as string[], greps: 0, reads: 0 }
  const title = (name: string) => { w.text += JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: ID }) + '\n' }
  if (opts.name !== undefined) title(opts.name)
  mock.env(on, opts.env ?? { CLAUDE_CONFIG_DIR: CONFIG })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('classic.UserPromptSubmit', () => ({}))
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (e.path !== PATH) throw new Error('ENOENT')
    return { value: { kind: 'file', size: opts.size ?? w.text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path !== PATH) throw new Error('ENOENT')
    w.reads++
    return { value: w.text }
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
  expect(w.renames).toEqual(['💤💤💤 Builder'])
  await clock.advance(30 * MIN) // stays asleep, no second rename
  expect(w.renames).toEqual(['💤💤💤 Builder'])
  await turn($, 't1')
  expect(w.renames).toEqual(['💤💤💤 Builder', 'Builder'])
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
  expect(w.renames).toEqual(['💤💤💤 Builder'])
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
  expect(w.renames).toEqual(['💤💤💤 Big one'])
  expect(w.greps).toBeGreaterThan(0)
  expect(w.reads).toBe(0)
})

test('options: idle minutes and prefix', { options: { idle_minutes: 2, prefix: '[idle] ' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(3 * MIN)
  expect(w.renames).toEqual(['[idle] Builder'])
  await turn($, 't1')
  expect(w.renames).toEqual(['[idle] Builder', 'Builder'])
})

test('wakes a name marked by an older prefix, and the path comes from the engine', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder', env: {} }) // no config dir in env: the reported path is used
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: PATH } as any)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
})

test('falls back to HOME/.claude when nothing else is known', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', env: { HOME: '/u' } })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤💤💤 Builder'])
})

test('a transcript it cannot find leaves the name alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder', env: { HOME: '/elsewhere' } })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual([])
})

test('a subagent turn does not wake the session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer' } as any)
  expect(w.renames).toEqual(['💤💤💤 Builder'])
})
