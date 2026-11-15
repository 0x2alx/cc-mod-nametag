import { expect, mock, test } from 'claude-code/testing'
import { cleanTopic, leader, recentLines } from './hooks/register'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONFIG = '/u/.claude'
const PROJECTS = ['-other-project', '-work-demo']
const MIN = 60 * 1000
const HOUR = 60 * MIN

// A fake world beneath the mod: one transcript, /rename appending a title row to it.
function world(on: any, opts: { name?: string; size?: number; env?: Record<string, string>; path?: string } = {}) {
  const w = {
    text: '{"type":"user","message":"hello"}\n', renames: [] as string[], greps: 0, reads: 0, lists: 0, attempts: 0,
    blocked: false, failRenames: 0, logs: [] as string[], store: new Map<string, unknown>(), gate: undefined as Promise<void> | undefined, id: ID,
    agents: [] as { id: string; status: string }[], results: {} as Record<string, unknown>, agentLists: 0,
    git: new Set<string>(), dirs: {} as Record<string, string[]>, messages: [] as { role: string; text: string }[],
    answers: [] as string[], asks: 0, prompts: [] as string[],
    title: (name: string) => { w.text += JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: w.id }) + '\n' },
  }
  const pathOf = () => opts.path ?? `${CONFIG}/projects/-work-demo/${w.id}.jsonl`
  const title = w.title
  if (opts.name !== undefined) title(opts.name)
  mock.env(on, opts.env ?? { CLAUDE_CONFIG_DIR: CONFIG })
  on('store.get', (_: unknown, e: { key: string }) => ({ value: w.store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => { w.store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_: unknown, e: { key: string }) => { w.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: w.messages.map(m => ({ ...m, toolUses: [] })) }))
  on('model.complete', (_: unknown, e: { prompt: string }) => {
    w.asks++
    w.prompts.push(String(e.prompt))
    const text = w.answers.shift()
    return { value: text === undefined ? { isAnswered: false, reason: 'api-error' } : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('agent.list', () => (w.agentLists++, { value: w.agents.map(a => ({ description: 'x', type: 'general-purpose', ...a })) }))
  on('tool.call', (_: unknown, e: { tool: string }) => ({ result: w.results[e.tool] ?? {} }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
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
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === pathOf() || w.git.has(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    w.lists++
    if (w.dirs[e.path]) return { value: w.dirs[e.path]!.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
    if (e.path !== `${CONFIG}/projects`) throw new Error('ENOENT')
    return { value: [...PROJECTS, pathOf().split('/').at(-2)].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    w.greps++
    const hits = w.text.split('\n').filter(l => l.includes('"type":"custom-title"'))
    return { value: { exitCode: hits.length ? 0 : 1, stdout: hits.join('\n'), stderr: '' } }
  })
  on('command.run', async (_: unknown, e: { command: string; args: string }) => {
    if (e.command === 'rename') {
      w.attempts++
      if (w.gate) await w.gate
      if (w.failRenames > 0) { w.failRenames--; throw new Error('rename refused') }
      w.renames.push(e.args); title(e.args)
    }
    return { text: `Session renamed to: ${e.args}` }
  })
  return w
}

// A record as the mod keeps it while a session is marked.
function preset(w: { store: Map<string, unknown> }, id: string, set: string, base: string, at = 1_000_000) {
  w.store.set(`mark:${id}`, { set, base, at })
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
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
  await clock.advance(11 * MIN) // the reset stands: the next idle spell marks again
  expect(w.renames).toEqual(['💤 Builder', 'Builder', '💤 Builder'])
})

test('position end keeps a name that starts with the emoji', { options: { position: 'end' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Notes' })
  await start($)
  await turn($, 't0') // first wake: an unmarked name read in any style would lose its 💤
  w.renames.length = 0
  w.title('💤 Notes') // the person names it again
  await clock.advance(11 * MIN)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Notes 💤', '💤 Notes'])
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
  expect(w.lists).toBeLessThanOrEqual(4)
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

test('a name this mod did not set is never parsed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual([])
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 💤 Builder'])
  await turn($, 't2')
  expect(w.renames).toEqual(['💤 💤 Builder', '💤 Builder'])
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

test('a rename while marked counts as activity once noticed; the new name is marked after a fresh idle spell', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  await start($)
  await clock.advance(11 * MIN)
  w.title('New name') // the person renames while marked, without sending anything
  await clock.advance(2 * HOUR + 50 * MIN) // level 2 is due: the mod notices the rename instead of marking
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(7 * MIN) // noticed at 3 h, so 3 h 08: not yet
  expect(w.renames).toEqual(['💤 Builder'])
  await clock.advance(3 * MIN) // 10 idle minutes after noticing
  expect(w.renames).toEqual(['💤 Builder', '💤 New name'])
  await turn($, 't1')
  expect(w.renames.at(-1)).toBe('New name')
})

test('upgrade from 0.5: a name it marked loses the mark once', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤💤 Builder' })
  const state = new Map<string, unknown>([['level', 1]]) // what 0.5 left in the session's state
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: state.get(e.key), version: state.has(e.key) ? 1 : 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => { state.set(e.key, e.value); return { value: { isSet: true, version: 2 } } })
  await start($)
  await turn($, 't1')
  await turn($, 't2')
  expect(w.renames).toEqual(['Builder'])
})

// What 0.5 left in the session's state (it survives the hot reload that brings in the new code).
function state05(on: any, level: number) {
  const state = new Map<string, unknown>([['level', level]])
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: state.get(e.key), version: state.has(e.key) ? 1 : 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => { state.set(e.key, e.value); return { value: { isSet: true, version: 2 } } })
  return state
}

test('upgrade from 0.5: the mark comes off as soon as the new code loads', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤 Builder' })
  const state = state05(on, 2)
  await start($)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
  expect(state.get('level')).toBe(null)
})

test('upgrade from 0.6.0 over a 0.5 mark: the stacked marks come off, the name is clean', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 💤💤 Builder' }) // 0.6.0 took "💤💤 Builder" for the person's name
  preset(w, ID, '💤 💤💤 Builder', '💤💤 Builder')
  const state = state05(on, 2)
  await start($)
  await turn($, 't1')
  expect(state.get('level')).toBe(null)
  expect(w.renames).toEqual(['Builder'])
  expect(w.store.size).toBe(0)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['Builder', '💤 Builder'])
})

test('upgrade from 0.6.0 over a 0.5 mark: clean at load, then marked from the clean name', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 💤 Builder' })
  preset(w, ID, '💤 💤 Builder', '💤 Builder')
  state05(on, 1)
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual(['Builder'])
  await clock.advance(10 * MIN)
  expect(w.renames).toEqual(['Builder', '💤 Builder'])
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder', '💤 Builder', 'Builder'])
})

test('upgrade from 0.5 when renames are refused: the next mark still builds from the clean name', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤 Builder' })
  w.failRenames = 2 // the upgrade at load and its retry in the start's wake
  const state = state05(on, 2)
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  expect(state.get('level')).toBe(null)
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
})

test('a session that starts marked (restart, resume) is woken at once, without a turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤💤 Builder' })
  preset(w, ID, '💤💤 Builder', 'Builder')
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual(['Builder'])
  expect(w.store.size).toBe(0)
  await turn($, 't1')
  expect(w.renames).toEqual(['Builder'])
})

test('a session renamed while it was closed keeps that name at start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: '💤 Builder' })
  preset(w, ID, '💤 Builder', 'Builder')
  w.title('Fresh name') // e.g. resumed with --name
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual([])
  expect(w.store.size).toBe(0)
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
  expect(w.agentLists).toBe(1)
  expect(w.renames).toEqual(['💤 Builder'])
})

test('records not touched for 90 days and holds that are over are dropped', async ($, on) => {
  mock.clock(on, { now: 100 * 24 * HOUR })
  const w = world(on, { name: 'Builder' })
  preset(w, 'old', 'x', 'y', 1)
  preset(w, 'new', 'x', 'y', 99 * 24 * HOUR)
  w.store.set('freeze:old', 100 * 24 * HOUR - 1)
  w.store.set('freeze:new', 100 * 24 * HOUR + HOUR)
  await start($)
  expect([...w.store.keys()]).toEqual(['mark:new', 'freeze:new'])
})

// ---- the topic ----

const TOPIC = { topic: 'on' } as const

// A workspace root: /work/demo holds projects of its own.
function workspace(w: any) {
  w.dirs['/work/demo'] = ['alpha', 'beta', '.cache']
  w.git.add('/work/demo/alpha/.git')
}

async function edit($: any, path: string, tool = 'Edit') {
  await $.tool.call({ tool, file_path: path, old_string: 'a', new_string: 'b' })
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
  expect(w.renames).toEqual(['Builder · alpha'])
  expect(w.asks).toBe(0)
  await clock.advance(11 * MIN)
  expect(w.renames.at(-1)).toBe('💤 Builder · alpha')
  await turn($, 'x1')
  expect(w.renames.at(-1)).toBe('Builder · alpha')
})

test('topic: no clear project, so the model is asked; its answer is cleaned', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [
    { role: 'user', text: 'compare the two offers' },
    { role: 'assistant', text: 'Offer A pays more.' },
    { role: 'user', text: '<command-name>/rename</command-name>' },
  ]
  w.answers = ['"Web Search!"']
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1)
  expect(w.prompts[0]).toContain('User: compare the two offers')
  expect(w.prompts[0]).not.toContain('/rename')
  expect(w.renames).toEqual(['Builder · Web-Search'])
})

test('topic: fewer than 3 turns, no check', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'hi' }]
  w.answers = ['greeting']
  await start($)
  await turns($, clock, 2)
  expect(w.asks).toBe(0)
  expect(w.renames).toEqual([])
})

test('topic: SAME keeps it; no break means no check for 2 hours', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'SAME', 'SAME']
  await start($)
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder · billing'])
  await clock.advance(5 * MIN)
  await turns($, clock, 3, 10) // 5 minutes later: within 30 minutes, no check
  expect(w.asks).toBe(1)
  for (let i = 0; i < 12; i++) { await clock.advance(8 * MIN); await turn($, `k${i}`) } // busy, never 10 minutes idle
  await turns($, clock, 3, 30)
  expect(w.asks).toBe(1) // no break and under 2 h: no check
  for (let i = 0; i < 3; i++) { await clock.advance(8 * MIN); await turn($, `m${i}`) }
  await turns($, clock, 3, 40)
  expect(w.asks).toBe(2) // 2 h passed
  expect(w.prompts[1]).toContain('Current label: billing')
  expect(w.renames).toEqual(['Builder · billing'])
})

test('topic: a break (back from 💤) checks again after 30 minutes', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'invoices']
  await start($)
  await turns($, clock, 3)
  await clock.advance(40 * MIN) // asleep
  expect(w.renames).toEqual(['Builder · billing', '💤 Builder · billing'])
  await turns($, clock, 3, 10)
  expect(w.asks).toBe(2)
  expect(w.renames).toEqual(['Builder · billing', '💤 Builder · billing', 'Builder · billing', 'Builder · invoices'])
})

// Busy turns 8 minutes apart (never 10 idle minutes), for `minutes` in all.
async function busyFor($: any, clock: any, minutes: number, tag: string) {
  for (let i = 0; i < Math.ceil(minutes / 8); i++) { await clock.advance(8 * MIN); await turn($, `${tag}${i}`) }
  await clock.advance(1)
}

test('topic: a check that finds nothing waits longer each time: 30 min, 1 h, 2 h', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  await start($)
  await turns($, clock, 3)
  expect(w.asks).toBe(1) // failed
  await busyFor($, clock, 40, 'a')
  expect(w.asks).toBe(1) // a miss: 1 h now
  await busyFor($, clock, 24, 'b')
  expect(w.asks).toBe(2) // failed again: 2 h now
  await busyFor($, clock, 64, 'c')
  expect(w.asks).toBe(2)
  w.answers = ['billing']
  await busyFor($, clock, 64, 'd')
  expect(w.asks).toBe(3)
  expect(w.renames).toEqual(['Builder · billing'])
})

test('topic: a model that only gives the name back counts as a miss', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Billing' })
  w.messages = [{ role: 'user', text: 'fix the billing bug' }]
  w.answers = ['billing', 'billing', 'billing']
  await start($)
  await turns($, clock, 3)
  await busyFor($, clock, 40, 'a')
  expect(w.asks).toBe(1)
  expect(w.renames).toEqual([])
})

test('topic: renamed from the app (no /rename), the next check (or 💤) sees it; with no hold the topic comes back', { options: { topic: 'on', topic_freeze_hours: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder · alpha'])
  w.title('Shipping')
  await edit($, '/work/demo/alpha/c.ts')
  await edit($, '/work/demo/alpha/d.ts')
  await busyFor($, clock, 32, 'z')
  expect(w.store.has(`mark:${ID}`)).toBe(true) // no break: the next check is at the 2-hour floor
  await busyFor($, clock, 96, 'a') // that check: the name is the person's now
  expect(w.renames).toEqual(['Builder · alpha'])
  expect(w.store.has(`mark:${ID}`)).toBe(false)
  await edit($, '/work/demo/alpha/e.ts')
  await edit($, '/work/demo/alpha/f.ts')
  await busyFor($, clock, 32, 'b')
  expect(w.renames).toEqual(['Builder · alpha', 'Shipping · alpha'])
})

test('topic: a search of the whole session folder says nothing', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.git.add('/work/demo/.git')
  w.messages = [{ role: 'user', text: 'hi' }]
  await start($)
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/work/demo' })
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
  expect(w.renames).toEqual(['Builder · setup'])
})

test('topic: this session\'s own record is never pruned, and its age starts over', async ($, on) => {
  mock.clock(on, { now: 100 * 24 * HOUR })
  const w = world(on, { name: 'Builder · alpha' })
  w.store.set(`mark:${ID}`, { set: 'Builder · alpha', base: 'Builder', at: 1, level: 0, topic: 'alpha' })
  await start($)
  expect((w.store.get(`mark:${ID}`) as any)?.at).toBe(100 * 24 * HOUR)
})

test('topic: the person renames it, so topics wait 4 hours', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  workspace(w)
  await start($)
  await edit($, '/work/demo/alpha/a.ts')
  await edit($, '/work/demo/alpha/b.ts')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder · alpha'])
  w.title('Shipping') // the person's /rename
  await clock.advance(11 * MIN) // the sleep notices the rename
  expect(w.renames).toEqual(['Builder · alpha'])
  expect(w.store.has(`freeze:${ID}`)).toBe(true)
  await edit($, '/work/demo/alpha/c.ts')
  await edit($, '/work/demo/alpha/d.ts')
  await clock.advance(30 * MIN)
  await turns($, clock, 3, 10)
  expect(w.renames.filter(r => r.includes('·'))).toEqual(['Builder · alpha']) // held: no topic on the new name
  expect(w.renames.at(-1)).toBe('Shipping')
  await clock.advance(4 * HOUR)
  await turns($, clock, 3, 20)
  expect(w.renames.at(-1)).toBe('Shipping · alpha')
})

test('topic: a session restarted with a topic keeps it', { options: TOPIC }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder · alpha' })
  w.store.set(`mark:${ID}`, { set: 'Builder · alpha', base: 'Builder', at: 1, level: 0, topic: 'alpha' })
  await start($)
  await clock.advance(MIN)
  expect(w.renames).toEqual([])
  await clock.advance(10 * MIN)
  expect(w.renames).toEqual(['💤 Builder · alpha'])
})

test('topic: turned off, a topic left in a name comes off with the next rename', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder · alpha' })
  w.store.set(`mark:${ID}`, { set: 'Builder · alpha', base: 'Builder', at: 1, level: 0, topic: 'alpha' })
  await start($)
  await clock.advance(11 * MIN)
  expect(w.renames).toEqual(['💤 Builder'])
  await turn($, 't1')
  expect(w.renames).toEqual(['💤 Builder', 'Builder'])
  expect(w.store.size).toBe(0)
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

test('topic: paths outside the root count by their repository; a separator option', { options: { topic: 'on', topic_separator: '|' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { name: 'Builder' })
  w.git.add('/srv/app/.git')
  await start($)
  await edit($, '/srv/app/server.py')
  await edit($, '/srv/app/lib/x.py', 'Write')
  await turns($, clock, 3)
  expect(w.renames).toEqual(['Builder | app'])
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
  expect(w.renames).toEqual(['Builder · cleanup'])
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

test('topic: the label cleanup', async () => {
  expect(cleanTopic('billing api', null)).toBe('billing-api')
  expect(cleanTopic('  "**Web Search**."\nbecause...', null)).toBe('Web-Search')
  expect(cleanTopic('SAME', 'alpha')).toBe('alpha')
  expect(cleanTopic('same.', null)).toBe(null)
  expect(cleanTopic('a-very-long-label-that-goes-on', null)).toBe('a-very-long-label-th')
  expect(cleanTopic('rm -rf / ; echo $HOME', null)).toBe('rm-rf-echo-HOME')
  expect(cleanTopic('🙂', null)).toBe(null)
  expect(cleanTopic('café-menu', null)).toBe('café-menu')
})

test('topic: a project leads with 60% of the weight and at least 5', async () => {
  expect(leader({ a: 6, b: 3 }, 9)).toBe('a')
  expect(leader({ a: 4 }, 4)).toBe(null)
  expect(leader({ a: 6, b: 5 }, 11)).toBe(null)
  expect(leader({ a: 6 }, 12)).toBe(null) // half the weight is outside any project
})

test('topic: recent lines skip command and notice rows, 6 prompts and 2 replies at most', async () => {
  const msgs = [
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', text: `ask ${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ role: 'assistant', text: `reply ${i}` })),
    { role: 'user', text: '<task-notification><task-id>b1</task-id></task-notification>' },
    { role: 'user', text: '' },
  ]
  const lines = recentLines(msgs)
  expect(lines.filter(l => l.startsWith('User:')).length).toBe(6)
  expect(lines.filter(l => l.startsWith('Claude:'))).toEqual(['Claude: reply 1', 'Claude: reply 2'])
  expect(lines.join('\n')).not.toContain('task-notification')
})
