export type Limit = { percentUsed: number; resetsAt?: string }

export type LastTurn = { seconds: number; outTokens: number | null; ctxDelta: number | null }

// The main thread's last request that read or wrote the prompt cache:
// when it was sent (the cache lifetime counts from there) and how long it holds.
export type CacheTimer = { at: number; ttlMs: number }

export type Snap = {
  fiveHour: Limit | null
  week: Limit | null
  ctxTokens: number | null
  ctxWindow: number
  compactAt: number | null
  now: number
  last: LastTurn | null
  // Optional: snaps stored by older versions of the mod have no `cache`.
  cache?: CacheTimer | null
}

// The 5-hour limit's percent used right before a keep-warm ping and after it
// (whole percents, as the limit reports them; null until the reading arrives).
export type PingCost = { before: number | null; after: number | null }

// Keep-warm: pings this chat just before the 1-hour prompt cache expires.
export type Warm = {
  on: boolean
  // When it was turned on or you last sent a message, whichever is later;
  // the auto-shutoff counts from here.
  since: number
  pings: number
  lastPingAt: number | null
  lastCost: PingCost | null
  // Why it last turned itself off, shown in the pane; null when you turned it off.
  stopped: string | null
}

// lim95: once the 5-hour limit reaches 95%, tells Claude (at its next tool
// call) to pause, wait out the window plus two minutes in a subagent, then go on.
export type Lim = {
  on: boolean
  // 95% was reached; the message goes out with the next tool result.
  pending: boolean
  // When it last told Claude to pause, and the 5h figures then.
  firedAt: number | null
  firedPct: number | null
  // The reset time of the window it fired in: it fires once per window, and
  // re-arms once that time has passed.
  firedFor: string | null
  // How long Claude was told to wait, and when that wait ends.
  sleepSecs: number | null
  resumeAt: number | null
  // The tool call whose result carried the message, marked in the transcript.
  toolUseId: string | null
}

// Whether the band above the prompt is hidden (it then takes no row at all).
// Optional: a value an earlier version stored here has no `hidden`.
export type BandView = { hidden?: boolean }

// When the open Usage pane was last redrawn by its refresh timer.
export type PaneTick = { at: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      snap: Snap | null
      warm: Warm | null
      lim: Lim | null
      band: BandView | null
      pane: PaneTick | null
    }
  }
}
