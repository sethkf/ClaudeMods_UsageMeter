# Usage Meter

A Claude Code mod that keeps your plan usage and context size in a band above the prompt, with a detail pane, an optional keep-warm toggle for the prompt cache, and an optional lim95 toggle that pauses Claude's work before the 5-hour limit runs out.

```
▾      5h 42% · 2h13m      wk 37% · 4d 4h      ctx: 51%      Warm lim95 ☰
```

## What it shows

**The band**, above the prompt box:

- **5h**: percent of your 5-hour limit used and the time until it resets. Once the reset time passes it reads `0% · reset` until the next reply brings new figures.
- **wk**: percent of your weekly limit used and the days and hours until it resets. A `▲` means you're using it faster than the week is passing.
- **ctx**: how full this chat's context window is.
- On a narrow window it switches to tighter wording rather than dropping anything.

**Buttons:**

- `▾` hides the band entirely, so it takes no space. Bring it back with right-click > **Show usage band**, or `/usage-band`.
- **Warm** turns keep-warm on or off (it's filled in while on).
- **lim95** turns the 95% pause on or off (it's filled in while on).
- `☰` opens or closes the **Usage** pane.

**The Usage pane** updates every second while it's open:

- Context used and the auto-compact point.
- The prompt cache: time left, its lifetime (5-minute or 1-hour), and when it was last refreshed (in UTC, e.g. `11:50z`).
- How long the last turn took and how much it added to the context.
- 5-hour limit used, when it resets (with a live countdown), and how long ago the figure was last checked.
- Keep-warm status: next ping, pings sent, time until it shuts off, and the 5-hour usage before and after the last ping.
- lim95 status: off, armed, about to tell Claude, or already fired this window. Below it, the last pause: when, at what percent, and when the wait ends (with a countdown).
- A breakdown of what's in the context, and how many tokens each source's skill listings add to every request.

## Keep-warm

Claude Code caches the conversation so each new message only pays full price for what's new. With the 1-hour cache, a chat left idle for over an hour goes cold, and the next message has to re-send the whole conversation at full price. In a long chat that can take a big bite out of your 5-hour limit.

With **Warm** on, the mod sends a short message in the chat about 3 minutes before the cache would expire, which refreshes it for another hour:

- The first ping in a chat within 24 hours says `keep cache warm. respond only with "understood".`; later ones just say `another ping. respond '.'`.
- It waits while a turn is running, and only pings a 1-hour cache.
- It turns itself off after 24 hours without a message from you, if the cache has already expired, or if a ping can't be sent.
- Each ping is a real message: it counts against your plan limits like any other. It's usually far cheaper than a cold restart of a large chat, but not free. The pane shows what the last one cost.
- It only works while Claude is open and the computer is awake.

## lim95

For long unattended work: instead of running into the 5-hour limit partway through a task, Claude pauses at 95%, waits for the window to reset, and then picks the work back up.

With **lim95** on:

- The 5-hour figure is re-checked every 15 seconds (once a minute while it's off), each time the engine reports it moved a point, and at every one of Claude's tool calls. All of these are local reads of figures Claude Code already has, so checking costs no usage. They keep running while Claude is working.
- Once it reads 95% or more, the next result of one of Claude's tool calls carries a message telling Claude to pause work, spawn a subagent with a sleep timer for the time left in the 5-hour window plus two minutes, and continue the work once the subagent says it's done. The wait is worked out when the message goes out, in seconds.
- The message reaches Claude in the middle of its turn, the way a message you type while Claude works does. A message the mod sent on its own would have to wait until the turn ended, by which point the limit may already be gone.
- A toast says when 95% is reached and when the message goes out. The tool call that carried it gets a `lim95: ...` line under it in the transcript, and the pane shows when the wait ends.
- It fires once per 5-hour window and re-arms by itself once that window resets, so it can carry a long job across several windows. Turning it off and on re-arms it straight away, and if you're already at 95% then, it fires at the next tool call.
- It only acts during a turn: if Claude is idle when the limit reaches 95%, the message goes out with the first tool call of the next turn.
- Subagents' own tool calls (the sleeper's included) are left alone.
- The wait itself is a long foreground subagent call. While it runs, no request refreshes the prompt cache, so a wait over an hour lets it go cold, and keep-warm can't ping while a turn is running.

## Install

Clone the repo somewhere you'll keep it:

```
git clone https://github.com/sethkf/ClaudeMods_UsageMeter.git
```

**Terminal:** start Claude Code with the mod loaded:

```
claude --plugin-dir /path/to/ClaudeMods_UsageMeter
```

**Desktop app, or to load it every time:** add the folder's full path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, then restart Claude:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/path/to/ClaudeMods_UsageMeter"
  }
}
```

It can also be set as a regular environment variable. Separate several folders with `;` on Windows or `:` elsewhere.

After changing the code, a terminal session reloads it when you save; in the desktop app, restart Claude.

## Claude Code CLI (likely works, needs testing)

The mod was built and used in the Claude desktop app. It runs on the same Claude Code engine as the CLI and draws with the terminal's own band and buttons, so it should work in a terminal session as is. So far it's only been tested there in the automated tests. If you try it, these are the differences to expect:

- **Hidden band:** right-click > **Show usage band** is desktop-only. Use `/usage-band` to bring the band back.
- **Usage pane:** `☰` or `/usage-meter` opens it at any width; the terminal only places it on its own when the window is at least 144 columns wide.
- **Keep-warm needs the session open.** A CLI chat only runs while its terminal does: close the terminal or end the session and the pings stop. One-shot `claude -p` runs have nothing to keep warm.
- **Keep-warm needs a 1-hour cache.** It only pings a 1-hour cache, and it hasn't been confirmed whether the CLI uses one on every plan. Open the pane after a reply and check the Cache line: `1-hour cache` means keep-warm will work; `5-minute cache` means Warm shows "waiting for a 1-hour cache" and never pings.
- **Resumed chats** (`claude --resume`) recover the cache timer from the transcript, as after a restart in the desktop app.

## Commands

- `/usage-meter`: opens the Usage pane.
- `/usage-band`: shows or hides the band.

## Settings

These are constants near the top of `hooks/register.tsx`:

- `KEEP_WARM_SHUTOFF_HOURS` (default `24`): hours without a message from you before keep-warm turns itself off; `0` means never.
- `WARM_LEAD_MS` (default 3 minutes): how long before the cache expires the ping is sent.
- `LIM_PCT` (default `95`): the 5-hour percent at which lim95 tells Claude to pause. The button keeps its `lim95` label (`LIM_LABEL`) unless you change that too.
- `LIM_PAD_MS` (default 2 minutes): added to the time left in the window for the wait.
- `LIM_SYNC_MS` (default 15 seconds): how often the 5-hour figure is re-checked while lim95 is on.

## What it reads and writes

- It reads the end of the current chat's transcript once at startup, to recover when the cache was last refreshed after Claude restarts.
- It saves the latest 5-hour and weekly readings to `~/.claude/plugins/data/usage-meter/limits.json`. Every open chat shares them, so a chat you haven't messaged in a while still shows current numbers, and the band has numbers right after a restart.
- It keeps a few small values (whether the band is hidden, when each chat last got a full ping) in Claude Code's own plugin storage.

Nothing is sent anywhere except the keep-warm pings, which go into the chat like a typed message, and the lim95 message, which Claude reads beside a tool result.

## Tests

```
claude plugin test /path/to/ClaudeMods_UsageMeter
```
