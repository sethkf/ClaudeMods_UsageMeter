import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, TurnUsage } from 'claude-code'

import type { CacheTimer, LastTurn, Lim, Limit, Snap, Warm } from '../types'

const snap = atom({ plugin: 'usage-meter', key: 'snap' } as const, null)
const warm = atom({ plugin: 'usage-meter', key: 'warm' } as const, null)
const lim = atom({ plugin: 'usage-meter', key: 'lim' } as const, null)
const band = atom({ plugin: 'usage-meter', key: 'band' } as const, null)
const paneTick = atom({ plugin: 'usage-meter', key: 'pane' } as const, null)

const PANE = 'usage-meter'
const WEEK_MS = 7 * 24 * 3600 * 1000

// --- Keep-warm settings -----------------------------------------------------
// The message sent in this chat to refresh the prompt cache.
const WARM_PROMPT = 'keep cache warm. respond only with "understood".'
// Every later ping in the same chat within FULL_PING_EVERY_MS of the full one.
const SHORT_WARM_PROMPT = `another ping. respond '.'`
const FULL_PING_EVERY_MS = 24 * 60 * 60 * 1000
const FULL_PING_KEY = 'fullPingAt'
// Keep-warm turns itself off this many hours after you last sent a message
// (or turned it on). 0 = never turn off by itself.
const KEEP_WARM_SHUTOFF_HOURS = 24
// How long before the cache expires the ping goes out.
const WARM_LEAD_MS = 3 * 60 * 1000

// --- lim95 settings -----------------------------------------------------------
// The 5-hour percent at which Claude is told to pause.
const LIM_PCT = 95
// Added to the time left in the 5-hour window for the wait.
const LIM_PAD_MS = 2 * 60 * 1000
// How often the 5-hour figure is re-read while lim95 is on (a local read of
// the engine's latest figure: it costs no usage). Once a minute otherwise.
const LIM_SYNC_MS = 15_000
const LIM_LABEL = 'lim95'

// --- Band layout --------------------------------------------------------------
// Columns kept free for the hide, Warm, lim95 and pane buttons when fitting the band.
const BUTTONS_COLS = 32
// The button that hides the band; right-click > Show usage band, or
// /usage-band, brings it back.
const HIDE_LABEL = '▾'
// The button that opens the Usage pane.
const PANE_LABEL = '☰'
// $.store key remembering whether the band is hidden, across sessions.
const HIDDEN_KEY = 'bandHidden'

const findLimit = (limits: SessionRateLimit[], kind: string): Limit | null => {
  const limit = limits.find(l => l.kind === kind)
  return limit ? { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt } : null
}

const msUntil = (iso: string | undefined, now: number) =>
  iso ? Math.max(0, Date.parse(iso) - now) : null

const hm = (ms: number | null) => {
  if (ms === null) return '?'
  const mins = Math.round(ms / 60000)
  return mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

// Days and hours: "3d 4h", or "5h" under a day.
const dh = (ms: number | null) => {
  if (ms === null) return '?'
  const totalHours = Math.round(ms / 3600000)
  const days = Math.floor(totalHours / 24)
  return days > 0 ? `${days}d ${totalHours % 24}h` : `${totalHours}h`
}

const k = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${n}`

const FIVE_MIN_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const SHUTOFF_MS = KEEP_WARM_SHUTOFF_HOURS * ONE_HOUR_MS

// The open Usage pane redraws every clock tick (each second) so its countdowns
// run live: a local re-read, so it costs no usage. The context breakdown, the
// one heavier read, is re-read after a message and at most this often.
const BREAKDOWN_EVERY_MS = 30_000

// How long the cache holds what a request wrote: the shorter lifetime when it
// wrote both; when it only read, whatever the previous write was given.
const cacheTtlMs = (usage: TurnUsage, previous: CacheTimer | null): number | null => {
  const wrote5m = (usage.ephemeral_5m_input_tokens ?? 0) > 0
  const wrote1h = (usage.ephemeral_1h_input_tokens ?? 0) > 0
  if (wrote5m) return FIVE_MIN_MS
  if (wrote1h) return ONE_HOUR_MS
  // A write with no lifetime reported is priced as five minutes.
  if (usage.cache_creation_input_tokens > 0) return FIVE_MIN_MS
  if (usage.cache_read_input_tokens > 0) return previous?.ttlMs ?? FIVE_MIN_MS
  return null
}

const mss = (ms: number) => {
  const secs = Math.floor(ms / 1000)
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

// Hours, minutes and seconds: "23:59:59".
const hmss = (ms: number) => {
  const secs = Math.floor(ms / 1000)
  const mm = String(Math.floor(secs / 60) % 60).padStart(2, '0')
  return `${Math.floor(secs / 3600)}:${mm}:${String(secs % 60).padStart(2, '0')}`
}

// A clock time in UTC, written as Zulu, e.g. "11:50z".
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}z`
}

// How long ago, e.g. "just now", "12m ago", "1h05m ago".
const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${ms < ONE_HOUR_MS ? `${Math.floor(ms / 60_000)}m` : hm(ms)} ago`)

// Time left, then when the cache was last refreshed (by a message, reply or ping).
const formatCache = (cache: CacheTimer, now: number) => {
  const left = cache.at + cache.ttlMs - now
  const kind = cache.ttlMs === ONE_HOUR_MS ? '1-hour' : '5-minute'
  const status = left > 0 ? `${mss(left)} left (${kind} cache)` : 'cold'
  return `${status} · last refreshed ${clockTime(cache.at)} (${ago(now - cache.at)})`
}

const formatLast = (last: LastTurn) => {
  let text = `${last.seconds}s`
  if (last.ctxDelta !== null) text += ` · ${last.ctxDelta >= 0 ? '+' : ''}${k(last.ctxDelta)} ctx`
  if (last.outTokens !== null) text += ` · ${k(last.outTokens)} out`
  return text
}

// One piece of the band: its usual text, and a tighter one for a narrow band.
// All three pieces are always shown.
type Segment = { text: string; short: string }

const segments = (s: Snap, now: number): Segment[] => {
  const parts: Segment[] = []

  // A window past its reset time reads 0% and "reset" until a reply brings the
  // new window's figures.
  const fiveHour = asOf(s.fiveHour, now)
  if (fiveHour) {
    const pct = `${fiveHour.percentUsed}%`
    const left = fiveHour.resetsAt ? hm(msUntil(fiveHour.resetsAt, now)) : 'reset'
    parts.push({ text: `5h ${pct} · ${left}`, short: `5h ${pct} ${left}` })
  }

  const week = asOf(s.week, now)
  if (week) {
    const pct = `${week.percentUsed}%`
    if (!week.resetsAt) {
      parts.push({ text: `wk ${pct} · reset`, short: `wk ${pct} reset` })
    } else {
      const left = msUntil(week.resetsAt, now)
      let pace = ''
      // Pace: share of the week already elapsed vs share of the limit used.
      if (left !== null) {
        const elapsedPct = ((WEEK_MS - left) / WEEK_MS) * 100
        if (week.percentUsed > elapsedPct + 5) pace = ' ▲'
      }
      parts.push({
        text: `wk ${pct} · ${dh(left)}${pace}`,
        short: `wk ${pct} ${dh(left).replace(' ', '')}${pace}`,
      })
    }
  }

  if (s.ctxTokens !== null && s.ctxWindow > 0) {
    const pct = `${Math.round((s.ctxTokens / s.ctxWindow) * 100)}%`
    parts.push({ text: `ctx: ${pct}`, short: `ctx ${pct}` })
  }

  return parts
}

const WAITING = 'waiting for first reply'
const join = (parts: Segment[]) => (parts.length ? parts.map(p => p.text).join(' | ') : WAITING)

// The whole band text, ignoring width: what the clock compares to know
// whether anything visible changed.
const format = (s: Snap, now: number) => join(segments(s, now))

// Fewest columns kept between two pieces of the band when they are spread out.
const MIN_GAP = 2

// The band's pieces for `cols` columns, one per spread-out slot: the usual
// wording when it fits with the minimum gaps, else the tighter one (each Text
// cuts at its edge if even that does not fit).
const fit = (s: Snap, now: number, cols: number): string[] => {
  const parts = segments(s, now)
  if (!parts.length) return [WAITING]
  const width = (texts: string[]) => texts.reduce((n, t) => n + t.length, 0) + MIN_GAP * (texts.length - 1)
  const full = parts.map(p => p.text)
  return width(full) <= cols ? full : parts.map(p => p.short)
}

let compactAt: number | null = null
let ctxAtTurnStart: number | null = null
let pendingTurn: { seconds: number; outTokens: number | null } | null = null
// Kept here too, for a step that lands before the first snap exists.
let lastCache: CacheTimer | null = null
// The pane reads these instead of the snap, so it does not redraw every second.
let lastTurn: LastTurn | null = null
let fiveHourNow: number | null = null
// A main-thread turn is running.
let busy = false
// Our ping is submitted and its turn has not ended yet.
let pinging = false
// The 5-hour percent when the ping went out.
let costBefore: number | null = null
// When the last message was sent or answered.
let lastMessageAt: number | null = null
// The pane's last read of the session's usage with its breakdown.
type UsageRead = Awaited<ReturnType<EngineInterface['session']['usage']>>
let paneUsage: { at: number; usage: UsageRead } | null = null

// Run every clock tick: redraws the Usage pane while it is shown.
async function refreshPane($: EngineInterface, now: number) {
  const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown !== false)
  if (shown) await update($, paneTick, () => ({ at: now }))
}

async function paneUsageAt($: EngineInterface, now: number): Promise<UsageRead> {
  const stale =
    !paneUsage || now - paneUsage.at >= BREAKDOWN_EVERY_MS || (lastMessageAt !== null && lastMessageAt >= paneUsage.at)
  if (stale) paneUsage = { at: now, usage: await $.session.usage({ breakdown: 'summary' }) }
  return paneUsage!.usage
}

// The plan limits are the account's, not one chat's: the last reading is kept
// across restarts and chats, and used until a reply brings a fresh one.
const LIMITS_KEY = 'limits'
// `at`: when the reading came in (absent in readings older versions saved).
type StoredLimits = { fiveHour: Limit | null; week: Limit | null; at?: number }
// When the reading this chat shows came in; 0 for none.
let limitsAt = 0
const SYNC_LIMITS_MS = 60_000
let limitsSyncedAt = 0
// When the 5-hour figure was last checked, by any route (shown in the pane).
let fiveCheckedAt: number | null = null

// A limit as it stands at `now`: once its reset time has passed the window has
// started over, so it reads 0% with no countdown (the next window's clock starts
// at the next message) instead of holding the old figure at 0m.
const asOf = (l: Limit | null | undefined, now: number): Limit | null =>
  !l ? null : l.resetsAt && Date.parse(l.resetsAt) <= now ? { percentUsed: 0 } : l

// The shared reading lives in a small file beside the engine's plugin data, so
// every open chat reads what any other just wrote (the store may be cached per
// chat). Found from the transcript path, `<config>/projects/<project>/<id>.jsonl`.
let limitsPath: string | null | undefined
async function limitsFile($: EngineInterface): Promise<string | null> {
  if (limitsPath !== undefined) return limitsPath
  try {
    const { transcriptPath } = await $.session.info()
    const m = /^(.*)[\\/]projects[\\/][^\\/]+[\\/][^\\/]+$/.exec(transcriptPath)
    limitsPath = m ? `${m[1]}/plugins/data/usage-meter/limits.json` : null
  } catch {
    limitsPath = null
  }
  return limitsPath
}

async function readStored($: EngineInterface): Promise<StoredLimits | null> {
  let fromFile: StoredLimits | null = null
  let fromStore: StoredLimits | null = null
  try {
    const path = await limitsFile($)
    if (path) fromFile = JSON.parse(await $.fs.read(path)) as StoredLimits
  } catch {
    // No file yet.
  }
  try {
    fromStore = ((await $.store.get(LIMITS_KEY)) as StoredLimits | undefined) ?? null
  } catch {
    // Nothing kept.
  }
  if (!fromFile) return fromStore
  if (!fromStore) return fromFile
  return (fromFile.at ?? 0) >= (fromStore.at ?? 0) ? fromFile : fromStore
}

async function writeStored($: EngineInterface, value: StoredLimits) {
  void $.store.set(LIMITS_KEY, value).catch(() => {})
  const path = await limitsFile($)
  if (path) void $.fs.write(path, JSON.stringify(value)).catch(() => {})
}

// The engine's last reading as this chat last saw it, to tell a new one from
// the same one read again.
let lastEngineKey = ''

async function limitsOrStored(
  $: EngineInterface,
  limits: SessionRateLimit[],
  now: number,
  previous: Snap | null,
): Promise<StoredLimits> {
  const fresh = { fiveHour: findLimit(limits, 'five_hour'), week: findLimit(limits, 'seven_day') }
  if (fresh.fiveHour || fresh.week) {
    const key = JSON.stringify(fresh)
    if (key !== lastEngineKey) {
      lastEngineKey = key
      limitsAt = now
      await writeStored($, { ...fresh, at: now })
      return fresh
    }
    // The same reading again: keep what is shown, which may be another chat's newer one.
    return { fiveHour: previous?.fiveHour ?? fresh.fiveHour, week: previous?.week ?? fresh.week }
  }
  const stored = await readStored($)
  if (stored) limitsAt = Math.max(limitsAt, stored.at ?? 1)
  return { fiveHour: stored?.fiveHour ?? null, week: stored?.week ?? null }
}

// Once a minute, every 15 seconds while lim95 is on (and with `force` right
// before a ping, which records the 5h figure): re-reads the engine's latest
// reading in case a change slipped by, then takes up a newer one another chat
// saved, so every chat shows the account's latest numbers without a reply of
// its own. The clock keeps ticking while Claude works, so this runs mid-turn too.
async function syncLimits($: EngineInterface, now: number, force = false) {
  const every = (await read($, lim))?.on ? LIM_SYNC_MS : SYNC_LIMITS_MS
  if (!force && now - limitsSyncedAt < every) return
  limitsSyncedAt = now
  fiveCheckedAt = now
  try {
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await apply($, usage.rateLimits, usage.context)
  } catch {
    // The shared reading below still applies.
  }
  const stored = await readStored($)
  const current = await read($, snap)
  if (!stored || !current) return
  const fills = (!current.fiveHour && !!stored.fiveHour) || (!current.week && !!stored.week)
  if ((stored.at ?? 1) <= limitsAt && !fills) return
  limitsAt = Math.max(limitsAt, stored.at ?? 1)
  const fiveHour = stored.fiveHour ?? current.fiveHour
  const week = stored.week ?? current.week
  fiveHourNow = fiveHour?.percentUsed ?? null
  await update($, snap, s => (s ? { ...s, fiveHour, week } : s))
}

// After a restart nothing has timed the cache yet: the transcript's newest
// request record says when it was sent and what lifetime it asked for.
// Best effort over an internal format: anything unexpected leaves it unknown.
async function cacheFromTranscript($: EngineInterface): Promise<CacheTimer | null> {
  try {
    const { transcriptPath } = await $.session.info()
    const { size } = await $.fs.stat(transcriptPath)
    for (const span of [1 << 20, 4 << 20]) {
      const offset = Math.max(0, size - span)
      const text = await $.fs.read(transcriptPath, { offset, length: size - offset })
      const lines = text.split('\n')
      if (offset > 0) lines.shift() // cut mid-line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line?.includes('"api-request"')) continue
        let row: any
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row?.type !== 'api-request' || row.agentId || /agent/i.test(row.querySource ?? '')) continue
        const at = Date.parse(row.timestamp)
        const ttls: unknown[] = Array.isArray(row.cacheControl) ? row.cacheControl.map((c: any) => c?.value?.ttl) : []
        if (!Number.isFinite(at) || ttls.length === 0) continue
        return { at, ttlMs: ttls.includes('1h') ? ONE_HOUR_MS : FIVE_MIN_MS }
      }
      if (offset === 0) break
    }
  } catch {
    // Unknown until the next reply.
  }
  return null
}

async function apply($: EngineInterface, limits: SessionRateLimit[], context: SessionContextUsage) {
  const previous = await read($, snap)
  const now = await $.clock.now()
  const { fiveHour, week } = await limitsOrStored($, limits, now, previous)
  const ctxTokens = context.tokens ?? null
  let last = previous?.last ?? null
  if (pendingTurn) {
    const ctxDelta = ctxTokens !== null && ctxAtTurnStart !== null ? ctxTokens - ctxAtTurnStart : null
    last = { ...pendingTurn, ctxDelta }
    pendingTurn = null
  }
  lastTurn = last
  const next: Snap = {
    fiveHour,
    week,
    ctxTokens,
    ctxWindow: context.window,
    compactAt,
    now,
    last,
    cache: previous?.cache ?? lastCache,
  }
  fiveHourNow = next.fiveHour?.percentUsed ?? null
  fiveCheckedAt = now
  await update($, snap, () => next)
  // The engine pushes a measure each time the 5h figure moves a point, mid-turn too.
  await checkLim($, now, next.fiveHour)
}

// --- lim95 --------------------------------------------------------------------

// Arms the message once the 5-hour limit reaches 95%, once per window: it goes
// out with the next tool result of the main thread.
async function checkLim($: EngineInterface, now: number, reading: Limit | null | undefined) {
  const l = await read($, lim)
  if (!l?.on || l.pending) return
  const five = asOf(reading, now)
  if (!five?.resetsAt || five.percentUsed < LIM_PCT) return
  // Already told Claude in this window: re-arms once it resets.
  if (l.firedFor && Date.parse(l.firedFor) > now) return
  let armed = false
  await update($, lim, x => {
    if (!x?.on || x.pending) return x
    armed = true
    return { ...x, pending: true }
  })
  if (armed) {
    $.ui.toast(`lim95: 5-hour limit at ${five.percentUsed}%. Claude will be told to pause at its next tool call.`)
  }
}

// What Claude reads beside the tool result: the wait counts from now, so it is
// worked out when the message goes out, not when 95% was reached.
const limMessage = (pct: number, resetsAt: string, now: number) => {
  const reset = Date.parse(resetsAt)
  const left = Math.max(0, reset - now)
  const secs = Math.ceil((left + LIM_PAD_MS) / 1000)
  const text =
    `lim95: the 5-hour usage limit is at ${pct}% and resets at ${clockTime(reset)} (in ${hm(left)}). ` +
    `Pause work here. Spawn a subagent with a sleep timer for ${secs} seconds ` +
    `(the time left in the 5-hour limit plus two minutes): its only job is to wait that long ` +
    `(in shorter chunks if a tool caps how long one wait can run) and then tell you it is done. ` +
    `Wait for it, and once it tells you it is done, continue the work where you left off.`
  return { text, secs }
}

async function toggleLim($: EngineInterface) {
  const now = await $.clock.now()
  const was = await read($, lim)
  await update($, lim, l =>
    l?.on
      ? { ...l, on: false, pending: false }
      : {
          on: true,
          pending: false,
          firedAt: l?.firedAt ?? null,
          firedPct: l?.firedPct ?? null,
          // Turning it on arms it again, even in a window it already fired in.
          firedFor: null,
          sleepSecs: l?.sleepSecs ?? null,
          resumeAt: l?.resumeAt ?? null,
          toolUseId: l?.toolUseId ?? null,
        },
  )
  $.ui.toast(
    was?.on
      ? 'lim95 off.'
      : `lim95 on: at ${LIM_PCT}% of the 5-hour limit, Claude is told to pause and wait out the window plus 2 minutes.`,
  )
  // Already past 95%: arm right away.
  if (!was?.on) await checkLim($, now, (await read($, snap))?.fiveHour)
}

async function stopWarm($: EngineInterface, reason: string) {
  await update($, warm, w => (w ? { ...w, on: false, stopped: reason } : w))
  $.ui.toast(`Keep-warm off: ${reason}.`)
}

async function toggleWarm($: EngineInterface) {
  const now = await $.clock.now()
  const was = await read($, warm)
  await update($, warm, w =>
    w?.on
      ? { ...w, on: false, stopped: null }
      : { on: true, since: now, pings: 0, lastPingAt: null, lastCost: w?.lastCost ?? null, stopped: null },
  )
  $.ui.toast(
    was?.on
      ? 'Keep-warm off.'
      : KEEP_WARM_SHUTOFF_HOURS > 0
        ? `Keep-warm on: pings before the cache expires, off after ${KEEP_WARM_SHUTOFF_HOURS}h without a message.`
        : 'Keep-warm on: pings before the cache expires.',
  )
}

// Hides the band (it then takes no row) or shows it again, and remembers it.
async function setBandHidden($: EngineInterface, hidden: boolean) {
  await update($, band, () => ({ hidden }))
  void $.store.set(HIDDEN_KEY, hidden).catch(() => {})
}

const isBandHidden = async ($: EngineInterface) => (await read($, band))?.hidden === true

// The ☰ button: opens the Usage pane, or closes it when it is already open.
async function togglePane($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: 'Usage' })
}

// Run every clock tick: sends the ping when the 1-hour cache is about to
// expire and nothing else is running.
async function keepWarm($: EngineInterface, s: Snap, now: number) {
  const w = await read($, warm)
  if (!w?.on) return
  if (SHUTOFF_MS > 0 && now - w.since >= SHUTOFF_MS) {
    return stopWarm($, `${KEEP_WARM_SHUTOFF_HOURS}h without a message from you`)
  }
  const c = s.cache
  if (!c || busy || pinging) return
  const left = c.at + c.ttlMs - now
  if (left <= 0) return stopWarm($, 'the cache had already expired')
  // A 5-minute cache would need a ping every few minutes: wait for a 1-hour one.
  if (c.ttlMs !== ONE_HOUR_MS || left > WARM_LEAD_MS) return
  pinging = true
  // The latest 5h reading, another chat's included, as the "before" figure.
  await syncLimits($, now, true).catch(() => {})
  costBefore = asOf((await read($, snap))?.fiveHour ?? s.fiveHour, now)?.percentUsed ?? null
  await update($, warm, x => (x ? { ...x, pings: x.pings + 1, lastPingAt: now } : x))
  const text = await pingText($, now)
  // A ping that cannot be sent turns keep-warm off rather than retrying each tick.
  $.prompt.submit({ text }).catch(() => {
    pinging = false
    void stopWarm($, 'the ping could not be sent')
  })
}

// The first ping in a chat within 24 hours spells out what it is; the rest are
// short, to keep each ping's input and reply small. Kept per chat in the store
// so a restart does not start the 24 hours over.
async function pingText($: EngineInterface, now: number): Promise<string> {
  try {
    const id = await $.session.id()
    const all = ((await $.store.get(FULL_PING_KEY)) as Record<string, number> | undefined) ?? {}
    const last = all[id]
    if (last !== undefined && now - last < FULL_PING_EVERY_MS) return SHORT_WARM_PROMPT
    // Keep only chats with a full ping inside the window, so the store stays small.
    const kept = Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < FULL_PING_EVERY_MS))
    await $.store.set(FULL_PING_KEY, { ...kept, [id]: now })
  } catch {
    // Unknown: the full prompt is the safe choice.
  }
  return WARM_PROMPT
}

const isPing = (text: string, origin: { kind: string } | undefined) =>
  origin?.kind === 'plugin' && (text === WARM_PROMPT || text === SHORT_WARM_PROMPT)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Clear any status line pinned by older versions of this mod.
    $.ui.status(undefined)
    await $.command.register({
      name: 'usage-meter',
      description: 'Open the usage pane (context, cache, last turn, keep-warm)',
    })
    await $.command.register({
      name: 'usage-band',
      description: 'Show or hide the usage band above the prompt',
    })
    // Hidden or shown as the band was last left.
    try {
      if ((await read($, band)) === null) {
        const hidden = (await $.store.get(HIDDEN_KEY)) === true
        await update($, band, () => ({ hidden }))
      }
    } catch {
      // Shown by default.
    }
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      compactAt = usage.context.breakdown?.autoCompactThreshold ?? null
      await apply($, usage.rateLimits, usage.context)
    } catch {
      // No reading yet; the numbers appear after the first reply.
    }
    // A restart forgets when the cache was last refreshed: recover it.
    if (!lastCache && !(await read($, snap))?.cache) {
      const recovered = await cacheFromTranscript($)
      if (recovered) {
        lastCache = recovered
        await update($, snap, s => (s ? { ...s, cache: recovered } : s))
      }
    }
    // Keep the countdowns moving between replies, and send keep-warm pings.
    // Ticks every second, but only redraws when the band's text would change.
    $.clock.every(1_000, () => {
      void (async () => {
        const now = await $.clock.now()
        await refreshPane($, now).catch(() => {})
        await syncLimits($, now).catch(() => {})
        const current = await read($, snap)
        if (!current) return
        await keepWarm($, current, now)
        await checkLim($, now, current.fiveHour)
        if (format(current, now) === format(current, current.now)) return
        await update($, snap, s => (s ? { ...s, now } : s))
      })()
    })
    return result
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage' })
    return { text: 'Usage pane opened.' }
  })

  on('command.run', { command: 'usage-band' }, async $ => {
    const hidden = !(await isBandHidden($))
    await setBandHidden($, hidden)
    return { text: hidden ? 'Usage band hidden.' : 'Usage band shown.' }
  })

  on('prompt.submit', async ($, e, next) => {
    ctxAtTurnStart = (await read($, snap))?.ctxTokens ?? null
    const now = await $.clock.now()
    lastMessageAt = now
    // A message of yours restarts the keep-warm shutoff clock.
    if (!isPing(e.text, e.origin)) {
      await update($, warm, w => (w?.on ? { ...w, since: now } : w))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main thread only; subagent turns report their own.
    if (!e.agentId) {
      busy = false
      lastMessageAt = await $.clock.now()
      pendingTurn = {
        seconds: Math.round(e.durationMs / 1000),
        outTokens: e.usage?.output_tokens ?? null,
      }
    }
    const result = await next(e)
    if (!e.agentId && pinging) {
      pinging = false
      const before = costBefore
      costBefore = null
      let after: number | null = null
      try {
        const usage = await $.session.usage()
        after = findLimit(usage.rateLimits, 'five_hour')?.percentUsed ?? null
      } catch {
        // Left unknown.
      }
      await update($, warm, w => (w ? { ...w, lastCost: { before, after } } : w))
    }
    return result
  })

  // Each model request of the main thread restarts the cache timer from the
  // moment it was sent (the cache lifetime counts from the request's start).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    const usage = result?.usage
    if (usage) {
      const previous = (await read($, snap))?.cache ?? lastCache
      const ttlMs = cacheTtlMs(usage, previous)
      if (ttlMs !== null) {
        lastCache = { at, ttlMs }
        const now = await $.clock.now()
        await update($, snap, s => (s ? { ...s, cache: lastCache, now } : s))
      }
    }
    return result
  })

  // lim95: every main-thread tool result re-reads the 5h figure, and once it is
  // at 95% carries the pause message to Claude in the middle of its turn (a
  // prompt of the mod's own would wait until the turn ended).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !(await read($, lim))?.on) return result
    const now = await $.clock.now()
    let five = (await read($, snap))?.fiveHour ?? null
    try {
      const usage = await $.session.usage()
      five = findLimit(usage.rateLimits, 'five_hour') ?? five
      fiveCheckedAt = now
    } catch {
      // The last reading stands.
    }
    await checkLim($, now, five)
    if (!(await read($, lim))?.pending || result.deny !== undefined) return result
    const current = asOf(five, now)
    if (!current?.resetsAt) {
      // The window reset before the message went out: nothing to wait for.
      await update($, lim, l => (l ? { ...l, pending: false } : l))
      return result
    }
    const { text, secs } = limMessage(current.percentUsed, current.resetsAt, now)
    const resumeAt = now + secs * 1000
    await update($, lim, l =>
      l
        ? {
            ...l,
            pending: false,
            firedAt: now,
            firedPct: current.percentUsed,
            firedFor: current.resetsAt!,
            sleepSecs: secs,
            resumeAt,
            toolUseId: e.tool_use_id ?? null,
          }
        : l,
    )
    $.ui.toast(`lim95: told Claude to pause and wait ${hm(secs * 1000)} (until ${clockTime(resumeAt)}).`)
    return { ...result, context: [...(result.context ?? []), text] }
  })

  // Marks, under the tool call that carried it, that lim95 told Claude to pause.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const l = await read($, lim)
    if (!l?.toolUseId || e.props.tool_use_id !== l.toolUseId) return next(e)
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const wait = l.sleepSecs !== null ? ` and wait ${hm(l.sleepSecs * 1000)}` : ''
    const until = l.resumeAt !== null ? ` (until ${clockTime(l.resumeAt)})` : ''
    return (
      <Box flexDirection="column">
        {row}
        <Text bold>
          lim95: 5h at {l.firedPct ?? '?'}%, told Claude to pause{wait}{until}, then continue.
        </Text>
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    await apply($, e.rateLimits, e.context)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Hidden: draw nothing, so the band takes no row.
    if (e.props.hasSurvey || (await isBandHidden($))) return next(e)
    const current = await read($, snap)
    const isOn = (await read($, warm))?.on ?? false
    const isLimOn = (await read($, lim))?.on ?? false

    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = Math.max(14, e.props.bodyColumns - BUTTONS_COLS)
    const pieces = current ? fit(current, current.now, cols) : [WAITING]
    // Hide button at the left, Warm and the pane button anchored at the right,
    // and the pieces spread evenly across the room between them.
    return (
      <Box alignItems="center" width="100%">
        <Button key="hide" label={HIDE_LABEL} onPress={() => void setBandHidden($, true)} />
        <Box
          flexGrow={1}
          flexShrink={1}
          justifyContent="space-evenly"
          alignItems="center"
          gap={MIN_GAP}
          marginX={1}
          overflow="hidden"
        >
          {pieces.map(p => (
            <Text dimColor wrap="truncate-end">
              {p}
            </Text>
          ))}
        </Box>
        <Box alignItems="center" gap={1} flexShrink={0}>
          {/* A plain button when off, the surface's filled primary one when on: same size either way. */}
          <Button
            key="warm"
            label="Warm"
            {...(isOn ? { variant: 'primary' as const } : {})}
            onPress={() => void toggleWarm($)}
          />
          <Button
            key="lim"
            label={LIM_LABEL}
            {...(isLimOn ? { variant: 'primary' as const } : {})}
            onPress={() => void toggleLim($)}
          />
          <Button key="pane" label={PANE_LABEL} onPress={() => void togglePane($)} />
        </Box>
      </Box>
    )
  })

  // While the band is hidden, the desktop app's right-click menu offers it back.
  on('ui.render', { component: 'ContextMenu' }, async ($, e, next) => {
    if (!(await isBandHidden($))) return next(e)
    const { Button } = $.ui.resolve(e)
    return (
      <Button key="show-band" onPress={() => void setBandHidden($, false)}>
        Show usage band
      </Button>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // Read so each refresh tick redraws the pane.
    await read($, paneTick)
    const now = await $.clock.now()
    const w = await read($, warm)
    const shownSnap = await read($, snap)
    const cache = shownSnap?.cache ?? lastCache
    const fiveHourShown = asOf(shownSnap?.fiveHour, now)

    // Keep-warm: what it is doing and what the last ping cost.
    let warmLine = 'Keep-warm: off'
    if (w?.on) {
      const parts = ['Keep-warm: on']
      if (cache) {
        const left = cache.at + cache.ttlMs - now
        if (cache.ttlMs !== ONE_HOUR_MS) parts.push('waiting for a 1-hour cache')
        else if (left > WARM_LEAD_MS) parts.push(`next ping in ${mss(left - WARM_LEAD_MS)}`)
      } else {
        parts.push('waiting for a reply to time the cache')
      }
      parts.push(`${w.pings} sent`)
      if (SHUTOFF_MS > 0) parts.push(`turns off in ${hmss(Math.max(0, w.since + SHUTOFF_MS - now))}`)
      warmLine = parts.join(' · ')
    } else if (w?.stopped) {
      warmLine = `Keep-warm: off (${w.stopped})`
    }
    const cost = w?.lastCost
    const costLine = cost
      ? `Last ping: 5h ${cost.before ?? '?'}% → ${cost.after ?? '?'}% (whole percents)`
      : null

    // The 5-hour limit: used, when it resets, and how fresh the reading is.
    let fiveLine: string | null = null
    if (fiveHourShown) {
      const parts = [`5-hour limit: ${fiveHourShown.percentUsed}% used`]
      if (fiveHourShown.resetsAt) {
        const reset = Date.parse(fiveHourShown.resetsAt)
        parts.push(`resets ${clockTime(reset)} (in ${hmss(Math.max(0, reset - now))})`)
      } else {
        parts.push('window reset')
      }
      if (fiveCheckedAt !== null) parts.push(`checked ${ago(now - fiveCheckedAt)}`)
      fiveLine = parts.join(' · ')
    }

    // lim95: armed, about to tell Claude, or waiting out the window.
    const l = await read($, lim)
    let limLine = 'lim95: off'
    if (l?.on) {
      const firedThisWindow = !!l.firedFor && Date.parse(l.firedFor) > now
      limLine = l.pending
        ? `lim95: on · 5h at ${fiveHourShown?.percentUsed ?? '?'}%, telling Claude at its next tool call`
        : firedThisWindow
          ? 'lim95: on · told Claude to pause in this window · re-arms when it resets'
          : `lim95: on · armed at ${LIM_PCT}% · checks the 5h figure every ${LIM_SYNC_MS / 1000}s and at each tool call`
    }
    let limLastLine: string | null = null
    if (l?.firedAt != null) {
      const parts = [`Last pause: ${clockTime(l.firedAt)} at ${l.firedPct ?? '?'}%`]
      if (l.resumeAt != null) {
        parts.push(
          l.resumeAt > now
            ? `wait ends ${clockTime(l.resumeAt)} (in ${hmss(l.resumeAt - now)})`
            : `wait ended ${clockTime(l.resumeAt)}`,
        )
      }
      limLastLine = parts.join(' · ')
    }

    const usage = await paneUsageAt($, now)
    const ctx = usage.context.tokens ?? null
    const ctxLine = ctx === null ? null : `Context: ${k(ctx)}/${k(usage.context.window)}`

    const header = (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        {ctxLine && <Text>{ctxLine}</Text>}
        {cache && <Text>Cache: {formatCache(cache, now)}</Text>}
        {lastTurn && <Text>Last turn: {formatLast(lastTurn)}</Text>}
        {compactAt !== null && <Text>Auto-compacts at {k(compactAt)}</Text>}
        {fiveLine && <Text>{fiveLine}</Text>}
        <Text>{warmLine}</Text>
        {costLine && <Text dimColor>{costLine}</Text>}
        <Text>{limLine}</Text>
        {limLastLine && <Text dimColor>{limLastLine}</Text>}
        <Text> </Text>
      </Box>
    )

    const b = usage.context.breakdown
    if (!b) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>No breakdown yet: send a message first.</Text>
        </Box>
      )
    }

    const loaded = b.categories.filter(c => !c.isDeferred && c.tokens > 0).sort((x, y) => y.tokens - x.tokens)
    const deferred = b.categories.filter(c => c.isDeferred && c.tokens > 0)

    // Skill listing cost grouped by plugin: shows what each plugin adds to every call.
    const byPlugin = new Map<string, number>()
    for (const skill of b.skills?.skillFrontmatter ?? []) {
      const key = skill.pluginName ?? `(${skill.source})`
      byPlugin.set(key, (byPlugin.get(key) ?? 0) + skill.tokens)
    }
    const plugins = [...byPlugin.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)

    return (
      <Box flexDirection="column">
        {header}
        <Text bold>
          {k(b.totalTokens)} of {k(b.maxTokens)} ({b.percentage}%) · {b.model}
        </Text>
        <Text> </Text>
        {loaded.map(c => (
          <Text>
            {k(c.tokens).padStart(7)}  {c.name}
          </Text>
        ))}
        {deferred.length > 0 && <Text dimColor>Deferred (not loaded until used): {deferred.map(c => `${c.name} ${k(c.tokens)}`).join(', ')}</Text>}
        {plugins.length > 0 && <Text> </Text>}
        {plugins.length > 0 && <Text bold>Skill listings by source</Text>}
        {plugins.map(([name, tokens]) => (
          <Text>
            {k(tokens).padStart(7)}  {name}
          </Text>
        ))}
      </Box>
    )
  })
}
