# Privacy Policy — Chronast

Chronast is a local MCP server. It makes no network requests of any kind.

## Data collection

Chronast does not collect any data. It has no analytics, telemetry, or tracking of any kind.

## Usage and storage

Chronast reads the system clock to report the current time and date. It persists a small local state file (last-check timestamp, session start time) to `~/.chronast/state-<pid>.json` on macOS/Linux or `%USERPROFILE%\.chronast\` on Windows. This file never leaves the user's machine and is not transmitted anywhere.

## Third-party sharing

None. Chronast has no network access and shares no data with any third party.

## Data retention

The local state file persists until the user manually deletes it (see the README's Uninstalling section) or uninstalls the extension and removes the state directory.

## Contact

For questions about this policy, open an issue at https://github.com/Loco-King/chronast/issues.
