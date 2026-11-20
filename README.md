# Usage Meter

A Claude Code mod that keeps your plan usage and context size in a band above the prompt, with a detail pane and an optional keep-warm toggle for the prompt cache.

```
▾      5h 42% · 2h13m      wk 37% · 4d 4h      ctx: 51%      Warm ☰
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
- `☰` opens or closes the **Usage** pane.

**The Usage pane** updates every second while it's open:

- Context used and the auto-compact point.
- The prompt cache: time left, its lifetime (5-minute or 1-hour), and when it was last refreshed (in UTC, e.g. `11:50z`).
- How long the last turn took and how much it added to the context.
- 5-hour limit used.
- Keep-warm status: next ping, pings sent, time until it shuts off, and the 5-hour usage before and after the last ping.
- A breakdown of what's in the context, and how many tokens each source's skill listings add to every request.

## Keep-warm

Claude Code caches the conversation so each new message only pays full price for what's new. With the 1-hour cache, a chat left idle for over an hour goes cold, and the next message has to re-send the whole conversation at full price. In a long chat that can take a big bite out of your 5-hour limit.

With **Warm** on, the mod sends a short message in the chat about 3 minutes before the cache would expire, which refreshes it for another hour:

- The first ping in a chat within 24 hours says `keep cache warm. respond only with "understood".`; later ones just say `another ping. respond '.'`.
- It waits while a turn is running, and only pings a 1-hour cache.
- It turns itself off after 24 hours without a message from you, if the cache has already expired, or if a ping can't be sent.
- Each ping is a real message: it counts against your plan limits like any other. It's usually far cheaper than a cold restart of a large chat, but not free. The pane shows what the last one cost.
- It only works while Claude is open and the computer is awake.

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

## What it reads and writes

- It reads the end of the current chat's transcript once at startup, to recover when the cache was last refreshed after Claude restarts.
- It saves the latest 5-hour and weekly readings to `~/.claude/plugins/data/usage-meter/limits.json`. Every open chat shares them, so a chat you haven't messaged in a while still shows current numbers, and the band has numbers right after a restart.
- It keeps a few small values (whether the band is hidden, when each chat last got a full ping) in Claude Code's own plugin storage.

Nothing is sent anywhere except the keep-warm pings, which go into the chat like a typed message.

## Tests

```
claude plugin test /path/to/ClaudeMods_UsageMeter
```
