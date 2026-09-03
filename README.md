# Chronast

Gives Claude Desktop a real clock — current time, date, elapsed-time
tracking, duration math, and timezone conversion. Runs entirely on your
own machine: no network calls, no telemetry, no account required.

## Install

1. Download `chronast.mcpb` from the [Releases page](https://github.com/Loco-King/chronast/releases) (or clone this repo and package it yourself — source is included, nothing is obfuscated)
2. Open **Claude Desktop** → **Settings** → **Extensions**
3. Click **Advanced settings** → **Extension Developer**
4. Click **Install Extension…** and select `chronast.mcpb`
5. Restart Claude Desktop (or start a new conversation)

## Source & contributing

This is free and open source (MIT licensed) — the source in `server.js` is
plain, unobfuscated JavaScript. Issues and pull requests welcome.

## Support this project

Chronast is free to use. If it's useful to you, you can support development at:
[Buy me a coffee on Ko-fi](https://ko-fi.com/locoking)

Questions or bugs: [open an issue](https://github.com/Loco-King/chronast/issues) on this repo.

## Getting Claude to actually use these tools automatically

Installing the extension only makes the tools *available* — Claude Desktop
has no built-in hook system (unlike Claude Code), so Claude won't call
`get_current_time`, `get_full_context`, etc. on its own initiative. It'll
only use them when you explicitly ask, or add an instruction telling it to.

To get the "always aware of the time" behavior, add something like this to
your Claude memory or custom instructions (Settings → Personal Preferences,
or per-Project custom instructions):

> User has Chronast installed in Claude Desktop with N tools
> (get_current_time, get_current_date, get_time_since_last_check,
> get_session_duration, calculate_duration, convert_time, get_full_context).
> Call get_full_context at the start of every conversation and whenever
> creating a new file. Never comment on the user's sleep, fatigue, energy,
> or the lateness of the hour based on this data unless the user raises it
> first.

Without this, the tools sit idle until you ask Claude to check the time —
which is still useful, just not automatic.

## Tools

| Tool | Purpose |
|---|---|
| `get_current_time` | Current local time, timezone, and unix timestamp |
| `get_current_date` | Current local date and day of week |
| `get_time_since_last_check` | Elapsed time since this tool (or any Chronast tool) was last called; flags large gaps |
| `get_session_duration` | Elapsed time since the current session started; auto-resets on a detected gap |
| `calculate_duration` | Elapsed time between two arbitrary date/time strings you supply |
| `convert_time` | Converts a time from one IANA timezone into one or more others |
| `get_full_context` | All of the above (except `calculate_duration`/`convert_time`) in a single call |

## Configurable gap threshold

`get_time_since_last_check`, `get_session_duration`, and `get_full_context`
accept an optional `gap_threshold_minutes` parameter. If omitted, the
default is 360 (6 hours) — elapsed time beyond that is flagged as a new,
discontinuous session rather than a continuation of the last one.

## Behavior note

Every tool's output includes a short instruction: this data is for
chronological coherence only, and Claude should not use it to comment on
sleep, fatigue, energy, or the lateness of the hour unless the user brings
it up first. This travels with the data itself so it survives regardless
of which tool is called.

## Known limitation: state isolation across concurrent conversations

Chronast persists a small amount of state (last-check time, session
start) to `~/.chronast/state-<pid>.json`, keyed by the server process's
PID. This means:

- If Claude Desktop spawns a separate server process per conversation,
  state is correctly isolated per conversation.
- If Claude Desktop reuses a single long-lived server process across
  multiple simultaneous conversations, session/gap tracking will be
  shared across those conversations rather than tracked independently.

There is currently no way for a stdio MCP server to receive a
conversation identifier from the client, so this can't be fully resolved
from the server side. In practice, most single-conversation usage is
unaffected.

## Uninstalling

Removing the extension from Claude Desktop does not delete its state
directory. To fully remove all traces, also delete:

- macOS/Linux: `~/.chronast/`
- Windows: `%USERPROFILE%\.chronast\`

## Privacy Policy

See [PRIVACY.md](PRIVACY.md) for the full policy.

Chronast makes no network requests of any kind. All data (system time,
state file) stays on your machine.

## Development

```bash
npm install
npm test         # or: node test.js
```

## License

MIT — see `LICENSE`.
