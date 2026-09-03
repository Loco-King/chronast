#!/usr/bin/env node
/**
 * Chronast
 * A local MCP server giving Claude Desktop a real clock — current
 * time/date, elapsed-time tracking, duration math, and timezone
 * conversion — entirely offline, no network calls.
 *
 * Tools:
 *   get_current_time()
 *   get_current_date()
 *   get_time_since_last_check(gap_threshold_minutes?)
 *   get_session_duration(gap_threshold_minutes?)
 *   calculate_duration(start, end?)
 *   convert_time(time?, from_timezone?, to_timezones)
 *   get_full_context(gap_threshold_minutes?)
 *
 * State (last-check timestamp, session start) is persisted to a small
 * JSON file so gaps and durations survive server restarts.
 *
 * KNOWN LIMITATION: state is isolated per server process (keyed by PID),
 * not per conversation — Claude Desktop's stdio MCP transport does not
 * expose a conversation identifier to the server. If Desktop spawns one
 * server process per conversation, this gives correct per-conversation
 * isolation. If Desktop reuses one long-lived process across multiple
 * concurrent conversations, session/gap tracking will be shared across
 * them. See README for details.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_DIR = path.join(os.homedir(), ".chronast");
const STATE_FILE = path.join(STATE_DIR, `state-${process.pid}.json`);

// Default gap threshold: how much elapsed real time before we flag the
// conversation as "not continuous." Callers can override per-call via
// the gap_threshold_minutes parameter; this is only the fallback.
const DEFAULT_GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("lastCheck" in parsed) ||
      !("sessionStart" in parsed)
    ) {
      throw new Error("state file has unexpected shape");
    }
    return parsed;
  } catch {
    // Missing, corrupt, or malformed — start fresh rather than crash.
    return { lastCheck: null, sessionStart: null };
  }
}

// Synchronous sleep, used only to back off between rename retries below.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Atomic write: write to a temp file then rename, so a crash or
    // concurrent read mid-write can't leave a half-written/corrupt file.
    const tmpFile = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");

    // On Windows, renaming over STATE_FILE can transiently fail with
    // EPERM/EBUSY if something else (commonly antivirus real-time
    // scanning) briefly holds a handle on it. Retry a few times with a
    // short backoff before giving up.
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpFile, STATE_FILE);
        return;
      } catch (err) {
        const retryable = err.code === "EPERM" || err.code === "EBUSY";
        if (!retryable || attempt === maxAttempts) throw err;
        sleepSync(10 * attempt);
      }
    }
  } catch (err) {
    // Non-fatal: if we can't persist, gap/session detection just resets
    // each time. Still safe to continue.
    console.error("chronast: failed to save state:", err.message);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours) parts.push(`${seconds}s`);
  return parts.join(" ") || "0s";
}

// Matches an ISO-8601-style date-time with no UTC offset/Z, e.g.
// "2026-06-15T12:00:00" or "2026-06-15 12:00:00.500" — the only shape we
// know how to reinterpret as wall-clock time in an arbitrary IANA zone.
const NAIVE_ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

// Returns the given IANA zone's UTC offset (in ms, positive = ahead of
// UTC) at the moment `instantMs`. Throws if `timeZone` isn't a real zone.
function offsetMsAt(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(instantMs))
    .reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instantMs;
}

// Interprets a naive (no-offset) ISO date-time string as wall-clock time
// in `timeZone` and returns the corresponding absolute instant in ms
// since epoch. Returns null if `naiveStr` isn't a shape we recognize.
// Throws if `timeZone` isn't a real IANA zone.
function zonedNaiveIsoToUtcMs(naiveStr, timeZone) {
  const m = naiveStr.match(NAIVE_ISO_DATETIME_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  // First guess: treat the wall-clock digits as if they were already UTC.
  const guessMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s ? Number(s) : 0, ms);

  // Correct by the zone's actual offset at that guess. Re-check once more
  // in case the offset itself changes near a DST transition boundary.
  const offset1 = offsetMsAt(guessMs, timeZone);
  let resultMs = guessMs - offset1;
  const offset2 = offsetMsAt(resultMs, timeZone);
  if (offset2 !== offset1) {
    resultMs = guessMs - offset2;
  }
  return resultMs;
}

function resolveGapThreshold(args) {
  const raw = args ? args.gap_threshold_minutes : undefined;
  if (raw === undefined || typeof raw !== "number" || Number.isNaN(raw)) {
    return { ms: DEFAULT_GAP_THRESHOLD_MS };
  }
  if (raw < 0) {
    return { error: "gap_threshold_minutes must be zero or positive" };
  }
  return { ms: raw * 60 * 1000 };
}

// A shared closing line baked into every tool's output so the anti-nanny
// rule travels with the data itself, not just the tool description.
const USAGE_NOTE =
  "Use this for chronological coherence and real elapsed time only. " +
  "Do not comment on the user's sleep, fatigue, energy, or the lateness " +
  "of the hour unless the user raises it first.";

const GAP_PARAM_SCHEMA = {
  gap_threshold_minutes: {
    type: "number",
    description:
      "Optional. Minutes of elapsed time before a gap is flagged as a " +
      "new session. Defaults to 360 (6 hours) if omitted.",
  },
};

const tools = {
  get_current_time: {
    description:
      "Returns the current local system time, with timezone and unix " +
      "timestamp. Call this whenever knowing the exact current time " +
      "matters (scheduling, deadlines, 'what time is it'). " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return {
        time: now.toLocaleTimeString(),
        iso: now.toISOString(),
        unixTimestamp: Math.floor(now.getTime() / 1000),
        timezone: tz,
        note: USAGE_NOTE,
      };
    },
  },

  get_current_date: {
    description:
      "Returns the current local system date, including day of week. " +
      "Call this whenever the exact current date matters (deadlines, " +
      "'what day is it', logging). " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => {
      const now = new Date();
      return {
        date: now.toLocaleDateString(),
        dayOfWeek: now.toLocaleDateString(undefined, { weekday: "long" }),
        iso: now.toISOString().slice(0, 10),
        note: USAGE_NOTE,
      };
    },
  },

  get_time_since_last_check: {
    description:
      "Returns real elapsed time since this tool (or any chronast tool) " +
      "was last called, and flags whether the gap is large enough that " +
      "the conversation should be treated as discontinuous rather than " +
      "a single continuous session. Updates the stored 'last check' " +
      "timestamp as a side effect. " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...GAP_PARAM_SCHEMA },
      additionalProperties: false,
    },
    handler: (args) => {
      const now = Date.now();
      const gapThreshold = resolveGapThreshold(args);
      if (gapThreshold.error) {
        return { error: gapThreshold.error, note: USAGE_NOTE };
      }
      const gapThresholdMs = gapThreshold.ms;
      const state = loadState();
      const lastCheck = state.lastCheck;

      let result;
      if (lastCheck === null) {
        result = {
          firstCheck: true,
          message: "No prior check recorded — this is the first call.",
        };
      } else {
        const elapsedMs = now - lastCheck;
        result = {
          firstCheck: false,
          elapsed: formatDuration(elapsedMs),
          elapsedMs,
          isGap: elapsedMs > gapThresholdMs,
          gapThreshold: formatDuration(gapThresholdMs),
        };
      }

      state.lastCheck = now;
      saveState(state);

      return { ...result, unixTimestamp: Math.floor(now / 1000), note: USAGE_NOTE };
    },
  },

  get_session_duration: {
    description:
      "Returns real elapsed time since the current session started. " +
      "Session start is recorded on first use and reset automatically " +
      "if the gap since the last check exceeded the threshold (i.e. a " +
      "new session is inferred). " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...GAP_PARAM_SCHEMA },
      additionalProperties: false,
    },
    handler: (args) => {
      const now = Date.now();
      const gapThreshold = resolveGapThreshold(args);
      if (gapThreshold.error) {
        return { error: gapThreshold.error, note: USAGE_NOTE };
      }
      const gapThresholdMs = gapThreshold.ms;
      const state = loadState();

      const gapExceeded =
        state.lastCheck !== null && now - state.lastCheck > gapThresholdMs;

      if (state.sessionStart === null || gapExceeded) {
        state.sessionStart = now;
      }
      state.lastCheck = now;
      saveState(state);

      const elapsedMs = now - state.sessionStart;
      return {
        sessionDuration: formatDuration(elapsedMs),
        sessionDurationMs: elapsedMs,
        newSessionDetected: gapExceeded,
        unixTimestamp: Math.floor(now / 1000),
        note: USAGE_NOTE,
      };
    },
  },

  calculate_duration: {
    description:
      "Calculates elapsed time between two arbitrary date/time strings " +
      "(e.g. 'March 3, 2026' and 'today', or two ISO timestamps). Use " +
      "this for questions like 'how long between X and Y', unrelated to " +
      "session or last-check tracking. Accepts anything JavaScript's " +
      "Date parser understands; if a value is omitted, the current time " +
      "is used. " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description:
            "Start date/time, as a parseable string (e.g. '2026-03-03', " +
            "'March 3 2026', '2026-03-03T14:00:00Z'). Required.",
        },
        end: {
          type: "string",
          description:
            "End date/time, same format rules as start. Omit to use the " +
            "current time.",
        },
      },
      required: ["start"],
      additionalProperties: false,
    },
    handler: (args) => {
      const startDate = new Date(args.start);
      if (isNaN(startDate.getTime())) {
        return {
          error: `Could not parse start value: "${args.start}"`,
          note: USAGE_NOTE,
        };
      }

      const endDate = args.end ? new Date(args.end) : new Date();
      if (isNaN(endDate.getTime())) {
        return {
          error: `Could not parse end value: "${args.end}"`,
          note: USAGE_NOTE,
        };
      }

      const diffMs = endDate.getTime() - startDate.getTime();
      return {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        duration: formatDuration(Math.abs(diffMs)),
        durationMs: Math.abs(diffMs),
        direction:
          diffMs > 0 ? "end is after start" : diffMs < 0 ? "end is before start" : "same",
        note: USAGE_NOTE,
      };
    },
  },

  convert_time: {
    description:
      "Converts a time from one timezone into one or more other " +
      "timezones (world clock / meeting-scheduling use case). Use IANA " +
      "timezone names (e.g. 'America/Toronto', 'Europe/London', " +
      "'Asia/Tokyo'). If 'time' is omitted, the current moment is used. " +
      "If 'from_timezone' is omitted, the system's local timezone is " +
      "used. 'from_timezone' only affects the result when 'time' is a " +
      "date-time string with no UTC offset (e.g. '2026-06-15T12:00:00', " +
      "not '...T12:00:00Z') — an offset-bearing or Z-suffixed 'time' " +
      "already unambiguously specifies an instant, so 'from_timezone' " +
      "is ignored in that case. " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        time: {
          type: "string",
          description:
            "Optional. A parseable date/time string. Omit to use the " +
            "current time. Include a UTC offset or 'Z' suffix (e.g. " +
            "'2026-06-15T12:00:00Z') for an unambiguous instant; omit " +
            "the offset and pair with 'from_timezone' to specify wall-" +
            "clock time in a particular zone.",
        },
        from_timezone: {
          type: "string",
          description:
            "Optional. IANA timezone name that 'time' is expressed in, " +
            "when 'time' has no UTC offset of its own. Omit to use the " +
            "system's local timezone. No effect if 'time' already has " +
            "an offset/Z suffix, or is omitted.",
        },
        to_timezones: {
          type: "array",
          items: { type: "string" },
          description:
            "Required. One or more IANA timezone names to convert into.",
        },
      },
      required: ["to_timezones"],
      additionalProperties: false,
    },
    handler: (args) => {
      const sourceTz =
        args.from_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

      if (args.from_timezone) {
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: args.from_timezone });
        } catch {
          return {
            error: `Invalid or unrecognized IANA timezone for from_timezone: "${args.from_timezone}"`,
            note: USAGE_NOTE,
          };
        }
      }

      let inputDate;
      if (args.time === undefined || args.time === null) {
        inputDate = new Date();
      } else if (args.from_timezone) {
        const zonedMs = zonedNaiveIsoToUtcMs(args.time.trim(), args.from_timezone);
        inputDate = zonedMs === null ? new Date(args.time) : new Date(zonedMs);
      } else {
        inputDate = new Date(args.time);
      }

      if (isNaN(inputDate.getTime())) {
        return {
          error: `Could not parse time value: "${args.time}"`,
          note: USAGE_NOTE,
        };
      }

      if (!Array.isArray(args.to_timezones) || args.to_timezones.length === 0) {
        return {
          error: "to_timezones must be a non-empty array of IANA timezone names.",
          note: USAGE_NOTE,
        };
      }

      const conversions = {};
      for (const tz of args.to_timezones) {
        try {
          conversions[tz] = new Intl.DateTimeFormat(undefined, {
            timeZone: tz,
            dateStyle: "medium",
            timeStyle: "long",
          }).format(inputDate);
        } catch {
          conversions[tz] = `Invalid or unrecognized IANA timezone: "${tz}"`;
        }
      }

      return {
        sourceTime: inputDate.toISOString(),
        sourceTimezone: sourceTz,
        conversions,
        note: USAGE_NOTE,
      };
    },
  },

  get_full_context: {
    description:
      "Convenience tool: returns current time, current date, time since " +
      "last check (with gap flag), and session duration in a single " +
      "call. Use this at the start of a conversation or whenever a full " +
      "chronological picture is needed at once, instead of calling the " +
      "other tools individually. Also updates last-check and session " +
      "state, same as calling get_time_since_last_check and " +
      "get_session_duration directly. " +
      USAGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...GAP_PARAM_SCHEMA },
      additionalProperties: false,
    },
    handler: (args) => {
      const now = Date.now();
      const gapThreshold = resolveGapThreshold(args);
      if (gapThreshold.error) {
        return { error: gapThreshold.error, note: USAGE_NOTE };
      }
      const gapThresholdMs = gapThreshold.ms;
      const nowDate = new Date(now);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const state = loadState();

      const lastCheck = state.lastCheck;
      let sinceLastCheck;
      if (lastCheck === null) {
        sinceLastCheck = {
          firstCheck: true,
          message: "No prior check recorded — this is the first call.",
        };
      } else {
        const elapsedMs = now - lastCheck;
        sinceLastCheck = {
          firstCheck: false,
          elapsed: formatDuration(elapsedMs),
          elapsedMs,
          isGap: elapsedMs > gapThresholdMs,
          gapThreshold: formatDuration(gapThresholdMs),
        };
      }

      const gapExceeded = lastCheck !== null && now - lastCheck > gapThresholdMs;
      if (state.sessionStart === null || gapExceeded) {
        state.sessionStart = now;
      }
      state.lastCheck = now;
      saveState(state);

      const sessionElapsedMs = now - state.sessionStart;

      return {
        time: nowDate.toLocaleTimeString(),
        date: nowDate.toLocaleDateString(),
        dayOfWeek: nowDate.toLocaleDateString(undefined, { weekday: "long" }),
        timezone: tz,
        iso: nowDate.toISOString(),
        unixTimestamp: Math.floor(now / 1000),
        sinceLastCheck,
        session: {
          duration: formatDuration(sessionElapsedMs),
          durationMs: sessionElapsedMs,
          newSessionDetected: gapExceeded,
        },
        note: USAGE_NOTE,
      };
    },
  },
};

const server = new Server(
  { name: "chronast", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const result = tool.handler(args || {});
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("chronast fatal error:", err);
  process.exit(1);
});
