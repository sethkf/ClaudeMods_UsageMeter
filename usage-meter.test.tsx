import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const MIN = 60 * 1000

const SNAP = {
  fiveHour: { percentUsed: 42, resetsAt: new Date(NOW + 133 * MIN).toISOString() },
  week: { percentUsed: 37, resetsAt: new Date(NOW + 100 * 60 * MIN).toISOString() },
  ctxTokens: 512_000,
  ctxWindow: 1_000_000,
  compactAt: 900_000,
  now: NOW,
  last: { seconds: 23, outTokens: 1100, ctxDelta: 3200 },
  cache: { at: NOW - 10 * MIN, ttlMs: 60 * MIN },
}

const band = (bodyColumns: number, surface: 'desktop' | 'terminal' = 'desktop') =>
  ({
    plugin: 'usage-meter',
    component: 'AbovePrompt',
    requestId: 'band',
    surface,
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 3 },
    },
  }) as const

// Seeds the snap an earlier reply stored, kept by the kit's own state from
// there on; answers the calls on $ the kit leaves to the test.
const seed = (on: any, value: unknown = SNAP) => {
  on('state.get', async (_: unknown, e: { key: string }, next: (e: unknown) => Promise<any>) => {
    const read = await next(e)
    return e.key === 'snap' && read?.value?.value === undefined
      ? { value: { value, version: read?.value?.version ?? 0 } }
      : read
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

// Records each keep-warm value the mod writes; the last is the one in force.
const watchWarm = (on: any) => {
  const writes: any[] = []
  on('state.set', (_: unknown, e: { key: string; value: unknown }, next: (e: unknown) => unknown) => {
    if (e.key === 'warm') writes.push(e.value)
    return next(e)
  })
  return () => writes[writes.length - 1]
}

// The band's spread-out pieces, left to right.
const pieces = async (ui: any) =>
  (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.dimColor).map((t: any) => t.text?.trim())

test('the band spreads 5h, weekly and ctx between hide and the right-hand buttons', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount(band(200))
  expect(await pieces(ui)).toEqual(['5h 42% · 2h13m', 'wk 37% · 4d 4h', 'ctx: 51%'])
  const middle = (await ui.findAll({ type: 'Box' })).find(b => b.props.justifyContent === 'space-evenly')
  expect(middle?.props.flexGrow).toBe(1)
  expect(middle?.text).toContain('wk 37%')
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  expect(buttons).toEqual(['hide', 'warm', 'lim', 'pane'])
  await ui.unmount()
})

test('a narrow band keeps all three, in tighter wording', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount(band(60))
  expect(await pieces(ui)).toEqual(['5h 42% 2h13m', 'wk 37% 4d4h', 'ctx 51%'])
  await ui.unmount()
})

test('a window past its reset time reads 0% and reset, not stuck at 0m', async ($, on) => {
  seed(on, {
    ...SNAP,
    fiveHour: { percentUsed: 99, resetsAt: new Date(NOW - MIN).toISOString() },
  })
  const ui = await $.ui.mount(band(200))
  expect(await pieces(ui)).toEqual(['5h 0% · reset', 'wk 37% · 4d 4h', 'ctx: 51%'])
  await ui.unmount()
})

test('hiding the band leaves no row; the right-click menu brings it back', async ($, on) => {
  seed(on)
  mock.store(on)
  const ui = await $.ui.mount(band(200))
  const menu = { plugin: 'usage-meter', surface: 'desktop', component: 'ContextMenu', props: {} } as const

  // Shown: no menu row.
  let m = await $.ui.mount(menu)
  expect(await m.find({ type: 'Button', key: 'show-band' })).toBeUndefined()
  await m.unmount()

  await ui.press({ key: 'hide' })
  await ui.redraw()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()

  m = await $.ui.mount(menu)
  await m.press({ key: 'show-band' })
  await m.unmount()
  await ui.redraw()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['hide', 'warm', 'lim', 'pane'])
  await ui.unmount()
})

test('the pane button opens the Usage pane, and closes it when open', async ($, on) => {
  seed(on)
  const calls: string[] = []
  let isOpen = false
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'usage-meter', title: 'Usage', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    calls.push(`open ${e.id}`)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: { id: string }) => {
    calls.push(`close ${e.id}`)
    isOpen = false
    return { value: undefined }
  })
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'pane' })
  await ui.press({ key: 'pane' })
  expect(calls).toEqual(['open usage-meter', 'close usage-meter'])
  await ui.unmount()
})

test('pressing Warm fills the button, same label, on desktop and terminal', async ($, on) => {
  seed(on)
  on('clock.now', () => ({ value: NOW }))
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(band(200, surface))
    const before = await ui.find({ type: 'Button', key: 'warm' })
    expect(before?.props.variant).toBeUndefined()

    await ui.press({ key: 'warm' })
    await ui.redraw()
    const after = await ui.find({ type: 'Button', key: 'warm' })
    expect(after?.props.variant).toBe('primary')
    expect(after?.props.label).toBe(before?.props.label)

    // Back off for the next surface.
    await ui.press({ key: 'warm' })
    await ui.unmount()
  }
})

test('keep-warm pings once, about 3 minutes before the 1-hour cache expires', async ($, on) => {
  // A cache with 3 minutes 5 seconds left.
  seed(on, { ...SNAP, cache: { at: NOW - 57 * MIN + 5000, ttlMs: 60 * MIN } })
  const warm = watchWarm(on)
  const clock = mock.clock(on, { now: NOW })
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'warm' })

  // Nothing while more than 3 minutes are left.
  await clock.advance(3000)
  expect(sent).toHaveLength(0)

  // Inside the last 3 minutes: one ping, and no second while it is out.
  await clock.advance(5000)
  expect(sent).toEqual(['keep cache warm. respond only with "understood".'])
  await clock.advance(10_000)
  expect(sent).toHaveLength(1)

  expect(warm()?.on).toBe(true)
  expect(warm()?.pings).toBe(1)
  await ui.unmount()
})

test('the open Usage pane redraws every second, and not when closed', async ($, on) => {
  seed(on)
  const clock = mock.clock(on, { now: NOW })
  const ticks: number[] = []
  on('state.set', (_: unknown, e: { key: string; value: any }, next: (e: unknown) => unknown) => {
    if (e.key === 'pane') ticks.push(e.value.at)
    return next(e)
  })
  let isOpen = true
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'usage-meter', title: 'Usage', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await clock.advance(5_000)
  expect(ticks.length).toBeGreaterThanOrEqual(4)

  isOpen = false
  const before = ticks.length
  await clock.advance(5_000)
  expect(ticks.length).toBe(before)
})

test('the pane shows time left on the cache and when it was last refreshed', async ($, on) => {
  seed(on)
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({
    value: { context: { tokens: 512_000, window: 1_000_000 }, rateLimits: [] },
  }))
  const ui = await $.ui.mount({
    plugin: 'usage-meter',
    component: 'Pane',
    requestId: 'usage-meter',
    surface: 'desktop',
    props: {},
  } as any)
  const line = await ui.find({ type: 'Text', text: /^Cache:/ })
  expect(line?.text).toMatch(/^Cache: 50:00 left \(1-hour cache\) · last refreshed 11:50z \(10m ago\)$/)
  await ui.unmount()
})

// A restart: the session's usage has no limits yet and nothing timed the cache.
const restart = (
  on: any,
  transcript: string,
  stored: unknown | (() => unknown) = undefined,
  files?: { transcriptPath: string; read: (path: string) => string },
) => {
  seed(on, null)
  on('store.get', (_: unknown, e: { key: string }) => ({
    value: e.key === 'limits' ? (typeof stored === 'function' ? stored() : stored) : undefined,
  }))
  on('store.set', () => ({ value: undefined }))
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: { tokens: 221_200, window: 1_000_000 }, rateLimits: [] } }))
  on('session.info', () => ({ value: { transcriptPath: files?.transcriptPath ?? '/t.jsonl' } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: transcript.length } }))
  on('fs.read', (_: unknown, e: { path: string; options?: { offset?: number } }) => ({
    value: files ? files.read(e.path) : transcript.slice(e.options?.offset ?? 0),
  }))
  return clock
}

test('after a restart the cache timer comes back from the transcript', async ($, on) => {
  const sent = new Date(NOW - 20 * MIN).toISOString()
  const transcript = [
    JSON.stringify({ type: 'api-request', timestamp: new Date(NOW - 40 * MIN).toISOString(), cacheControl: [{ value: { ttl: '1h' } }] }),
    JSON.stringify({ type: 'api-request', timestamp: sent, querySource: 'sdk', cacheControl: [{ value: { type: 'ephemeral', ttl: '1h' } }] }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 19 * MIN).toISOString() }),
    '',
  ].join('\n')
  restart(on, transcript)
  const snaps: any[] = []
  on('state.set', (_: unknown, e: { key: string; value: unknown }, next: (e: unknown) => unknown) => {
    if (e.key === 'snap') snaps.push(e.value)
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(snaps.at(-1)?.cache).toEqual({ at: Date.parse(sent), ttlMs: 60 * MIN })
})

test('after a restart the band shows the last 5h and weekly reading', async ($, on) => {
  restart(on, '', { fiveHour: SNAP.fiveHour, week: SNAP.week })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  expect(await pieces(ui)).toEqual(['5h 42% · 2h13m', 'wk 37% · 4d 4h', 'ctx: 22%'])
  await ui.unmount()
})

test("a chat with no reading of its own takes up another chat's newer one", async ($, on) => {
  // This chat started before any reading was saved; another chat saved one since.
  let stored: unknown = undefined
  const clock = restart(on, '', () => stored)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  expect(await pieces(ui)).toEqual(['ctx: 22%'])

  stored = { fiveHour: { ...SNAP.fiveHour, percentUsed: 61 }, week: SNAP.week, at: NOW + 1000 }
  await clock.advance(32_000)
  await ui.redraw()
  expect((await pieces(ui))[0]).toMatch(/^5h 61% · /)
  await ui.unmount()
})

test('chats share the newest reading through a file beside the plugin data', async ($, on) => {
  let file: string | null = null
  const clock = restart(on, '', undefined, {
    transcriptPath: '/home/me/.claude/projects/p/chat.jsonl',
    read: path => {
      // The engine hands paths on in the platform's form.
      const isLimits = path.replace(/\\/g, '/').endsWith('/home/me/.claude/plugins/data/usage-meter/limits.json')
      if (!isLimits || file === null) throw new Error('ENOENT')
      return file
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  expect(await pieces(ui)).toEqual(['ctx: 22%'])

  // Another chat writes a newer reading to the file.
  file = JSON.stringify({ fiveHour: { ...SNAP.fiveHour, percentUsed: 12 }, week: SNAP.week, at: NOW + 1000 })
  await clock.advance(32_000)
  await ui.redraw()
  expect((await pieces(ui))[0]).toMatch(/^5h 12% · /)
  await ui.unmount()
})

test('after a full ping in the last 24h, the next ping is the short one', async ($, on) => {
  seed(on, { ...SNAP, cache: { at: NOW - 57 * MIN + 5000, ttlMs: 60 * MIN } })
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { fullPingAt: { 'chat-1': NOW - 5 * 60 * MIN } }
  on('store.get', (_: unknown, e: { key: string }) => ({ value: saved[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'chat-1' }))
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'warm' })
  await clock.advance(8000)
  expect(sent).toEqual([`another ping. respond '.'`])
  await ui.unmount()
})

test('keep-warm turns itself off when the cache has already expired', async ($, on) => {
  seed(on)
  const warm = watchWarm(on)
  const clock = mock.clock(on, { now: NOW + 61 * MIN })
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'warm' })
  await clock.advance(2000)

  expect(warm()?.on).toBe(false)
  expect(warm()?.stopped).toBe('the cache had already expired')
  await ui.unmount()
})

// lim95: a session whose engine reads the 5-hour limit at `pct`, resetting in 133 minutes.
const limSession = (on: any, pct: number) => {
  const fiveHour = { percentUsed: pct, resetsAt: SNAP.fiveHour.resetsAt }
  seed(on, { ...SNAP, fiveHour })
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: {
      context: { tokens: 512_000, window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', ...fiveHour }],
    },
  }))
  on('tool.call', () => ({ result: {} }))
  return clock
}

test('pressing lim95 fills the button, on desktop and terminal', async ($, on) => {
  limSession(on, 42)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(band(200, surface))
    expect((await ui.find({ type: 'Button', key: 'lim' }))?.props.variant).toBeUndefined()
    await ui.press({ key: 'lim' })
    await ui.redraw()
    const after = await ui.find({ type: 'Button', key: 'lim' })
    expect(after?.props.variant).toBe('primary')
    expect(after?.props.label).toBe('lim95')
    await ui.press({ key: 'lim' })
    await ui.unmount()
  }
})

test('at 95% lim95 tells Claude once, with the next tool result, to pause and wait out the window + 2m', async ($, on) => {
  limSession(on, 96)
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'lim' })

  // A subagent's tool call carries nothing.
  const sub: any = await $.tool.call({ tool: 'Bash', command: 'sleep 1', agentId: 'a1' } as any)
  expect(sub.context ?? []).toHaveLength(0)

  const first: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context).toHaveLength(1)
  const text: string = first.context[0]
  // 133 minutes left plus 2: 8100 seconds.
  expect(text).toContain('Pause work here.')
  expect(text).toContain('sleep timer for 8100 seconds')
  expect(text).toContain('continue the work where you left off')

  // Once per window.
  const second: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(second.context ?? []).toHaveLength(0)
  await ui.unmount()
})

test('below 95%, tool results carry nothing', async ($, on) => {
  limSession(on, 94)
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'lim' })
  const below: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(below.context ?? []).toHaveLength(0)
  await ui.unmount()
})

test('with lim95 off, 96% carries nothing', async ($, on) => {
  limSession(on, 96)
  const off: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(off.context ?? []).toHaveLength(0)
})

test('the pane shows lim95 armed, then the pause and when the wait ends', async ($, on) => {
  limSession(on, 96)
  const band0 = await $.ui.mount(band(200))
  await band0.press({ key: 'lim' })
  const pane = await $.ui.mount({
    plugin: 'usage-meter',
    component: 'Pane',
    requestId: 'usage-meter',
    surface: 'desktop',
    props: {},
  } as any)
  expect((await pane.find({ type: 'Text', text: /^lim95:/ }))?.text).toMatch(/telling Claude at its next tool call/)
  expect((await pane.find({ type: 'Text', text: /^5-hour limit:/ }))?.text).toMatch(
    /^5-hour limit: 96% used · resets 14:13z \(in 2:13:00\)/,
  )

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await pane.redraw()
  expect((await pane.find({ type: 'Text', text: /^lim95:/ }))?.text).toMatch(/told Claude to pause in this window/)
  expect((await pane.find({ type: 'Text', text: /^Last pause:/ }))?.text).toBe(
    'Last pause: 12:00z at 96% · wait ends 14:15z (in 2:15:00)',
  )
  await pane.unmount()
  await band0.unmount()
})

test('the tool call that carried the message is marked in the transcript', async ($, on) => {
  limSession(on, 96)
  const b = await $.ui.mount(band(200))
  await b.press({ key: 'lim' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-1' } as any)
  for (const id of ['tu-1', 'tu-2']) {
    const row = await $.ui.mount({
      plugin: 'usage-meter',
      component: 'ToolUse',
      requestId: id,
      surface: 'desktop',
      props: { tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
    } as any)
    const note = await row.find({ type: 'Text', text: /^lim95:/ })
    if (id === 'tu-1') expect(note?.text).toBe('lim95: 5h at 96%, told Claude to pause and wait 2h15m (until 14:15z), then continue.')
    else expect(note).toBeUndefined()
    await row.unmount()
  }
  await b.unmount()
})
