#!/usr/bin/env node
/**
 * Minimal test suite for Chronast. No test framework dependency —
 * plain assertions, run with `node test.js`. Exits non-zero on failure
 * so it can be wired into CI later if desired.
 */

const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

let passed = 0;
let failed = 0;

function check(description, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${description}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${description}`);
    console.error(`    ${err.message}`);
  }
}

// --- Unit tests for formatDuration, via a fresh require of the module's
// internals is not possible since they aren't exported, so we test the
// same logic inline. Keep this in sync with server.js if the formatting
// logic changes. ---
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

console.log("Unit tests: formatDuration");
check("zero ms formats as 0s", () => {
  assert.strictEqual(formatDuration(0), "0s");
});
check("30 seconds", () => {
  assert.strictEqual(formatDuration(30 * 1000), "30s");
});
check("90 seconds rolls into minutes", () => {
  assert.strictEqual(formatDuration(90 * 1000), "1m 30s");
});
check("exactly 1 hour", () => {
  assert.strictEqual(formatDuration(60 * 60 * 1000), "1h");
});
check("1 day 2 hours 3 minutes", () => {
  const ms = (24 + 2) * 60 * 60 * 1000 + 3 * 60 * 1000;
  assert.strictEqual(formatDuration(ms), "1d 2h 3m");
});

// --- Integration tests: spawn the real server over stdio, same as
// Claude Desktop would, and exercise each tool through the actual MCP
// protocol.
function runServerTest(testFn) {
  return new Promise((resolve) => {
    const proc = spawn("node", [path.join(__dirname, "server.js")]);
    let buffer = "";
    const responses = {};

    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses[msg.id] = msg;
        } catch {
          // ignore non-JSON stray output
        }
      }
    });

    function send(msg) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }

    async function waitFor(id, timeoutMs = 10000) {
      const start = Date.now();
      while (!(id in responses)) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for id ${id}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return responses[id];
    }

    (async () => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });
      await waitFor(1);
      await testFn({ send, waitFor });
      proc.kill();
      resolve();
    })().catch((err) => {
      proc.kill();
      resolve(); // failures are reported via `check`, not thrown here
      throw err;
    });
  });
}

async function main() {
  console.log("\nIntegration tests: live MCP protocol calls");

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_current_time", arguments: {} },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("get_current_time returns a timezone string", () => {
      assert.ok(typeof parsed.timezone === "string" && parsed.timezone.length > 0);
    });
    check("get_current_time returns a unix timestamp", () => {
      assert.ok(typeof parsed.unixTimestamp === "number" && parsed.unixTimestamp > 0);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_current_date", arguments: {} },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("get_current_date returns a dayOfWeek string", () => {
      assert.ok(typeof parsed.dayOfWeek === "string" && parsed.dayOfWeek.length > 0);
    });
    check("get_current_date returns an iso date (YYYY-MM-DD)", () => {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(parsed.iso));
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "calculate_duration",
        arguments: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("calculate_duration: 1 day apart reports '1d'", () => {
      assert.strictEqual(parsed.duration, "1d");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "calculate_duration",
        arguments: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("calculate_duration: identical start and end reports direction 'same'", () => {
      assert.strictEqual(parsed.direction, "same");
    });
    check("calculate_duration: identical start and end reports durationMs 0", () => {
      assert.strictEqual(parsed.durationMs, 0);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "calculate_duration", arguments: { start: "not a real date" } },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("calculate_duration: invalid date returns an error field, not a crash", () => {
      assert.ok(typeof parsed.error === "string");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: {
          time: "2026-06-15T12:00:00Z",
          to_timezones: ["America/Toronto", "Asia/Tokyo", "Not/ARealZone"],
        },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: converts to valid timezones", () => {
      assert.ok(parsed.conversions["America/Toronto"].length > 0);
      assert.ok(parsed.conversions["Asia/Tokyo"].length > 0);
    });
    check("convert_time: invalid timezone reports an error, not a crash", () => {
      assert.ok(parsed.conversions["Not/ARealZone"].includes("Invalid"));
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    // Regression test: from_timezone must actually shift a naive (no
    // offset) input time, not just get echoed back as sourceTimezone
    // while being silently ignored in the actual computation.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: { time: "2026-06-15T12:00:00", from_timezone: "Asia/Tokyo", to_timezones: ["UTC"] },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: from_timezone actually shifts a naive time (Asia/Tokyo noon -> 03:00 UTC)", () => {
      assert.strictEqual(parsed.sourceTime, "2026-06-15T03:00:00.000Z");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: { time: "2026-06-15T12:00:00", from_timezone: "Europe/London", to_timezones: ["UTC"] },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: from_timezone respects BST (Europe/London noon in June -> 11:00 UTC)", () => {
      assert.strictEqual(parsed.sourceTime, "2026-06-15T11:00:00.000Z");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: { time: "2026-06-15T12:00:00", from_timezone: "Asia/Kolkata", to_timezones: ["UTC"] },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: from_timezone handles a half-hour offset zone (Asia/Kolkata, UTC+5:30)", () => {
      assert.strictEqual(parsed.sourceTime, "2026-06-15T06:30:00.000Z");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: { time: "2026-06-15T12:00:00Z", from_timezone: "Asia/Tokyo", to_timezones: ["UTC"] },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: from_timezone is ignored (not applied) when time already has a Z/offset", () => {
      assert.strictEqual(parsed.sourceTime, "2026-06-15T12:00:00.000Z");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "convert_time", arguments: { time: "", to_timezones: ["UTC"] } },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: empty-string time returns an error, aligned with calculate_duration", () => {
      assert.ok(typeof parsed.error === "string");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: { time: "2026-06-15T12:00:00", from_timezone: "Not/ARealZone", to_timezones: ["UTC"] },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: invalid from_timezone returns an explicit error, not a silent echo", () => {
      assert.ok(typeof parsed.error === "string" && parsed.error.includes("from_timezone"));
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "convert_time", arguments: { to_timezones: [] } },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("convert_time: empty to_timezones array returns an error, not a crash", () => {
      assert.ok(typeof parsed.error === "string");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_time_since_last_check", arguments: {} },
    });
    const first = await waitFor(2);
    const firstParsed = JSON.parse(first.result.content[0].text);
    check("get_time_since_last_check: first call reports firstCheck true", () => {
      assert.strictEqual(firstParsed.firstCheck, true);
    });

    await new Promise((r) => setTimeout(r, 100));
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_time_since_last_check",
        arguments: { gap_threshold_minutes: 0.001 },
      },
    });
    const second = await waitFor(3);
    const secondParsed = JSON.parse(second.result.content[0].text);
    check("get_time_since_last_check: second call reports firstCheck false", () => {
      assert.strictEqual(secondParsed.firstCheck, false);
    });
    check("get_time_since_last_check: tiny custom threshold flags a gap", () => {
      assert.strictEqual(secondParsed.isGap, true);
    });

    await new Promise((r) => setTimeout(r, 20));
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_time_since_last_check",
        arguments: { gap_threshold_minutes: 0 },
      },
    });
    const third = await waitFor(4);
    const thirdParsed = JSON.parse(third.result.content[0].text);
    check("get_time_since_last_check: gap_threshold_minutes 0 is applied, not defaulted", () => {
      assert.strictEqual(thirdParsed.gapThreshold, "0s");
    });

    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_time_since_last_check",
        arguments: { gap_threshold_minutes: -5 },
      },
    });
    const fourth = await waitFor(5);
    const fourthParsed = JSON.parse(fourth.result.content[0].text);
    check("get_time_since_last_check: negative gap_threshold_minutes returns an error, not a crash or silent default", () => {
      assert.strictEqual(fourthParsed.error, "gap_threshold_minutes must be zero or positive");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_session_duration",
        arguments: { gap_threshold_minutes: -1 },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("get_session_duration: negative gap_threshold_minutes returns an error, not a crash or silent default", () => {
      assert.strictEqual(parsed.error, "gap_threshold_minutes must be zero or positive");
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_session_duration", arguments: {} },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    // Changed in the conversation-scoping fix. This previously asserted
    // `false`, which encoded the defect: the one call that actually starts
    // a session reported that it hadn't, because the flag returned only
    // `gapExceeded` and a first call has no gap to exceed.
    check("get_session_duration: reports newSessionDetected true on the call that starts a session", () => {
      assert.strictEqual(parsed.newSessionDetected, true);
    });
    check("get_session_duration: includes a unix timestamp", () => {
      assert.ok(typeof parsed.unixTimestamp === "number" && parsed.unixTimestamp > 0);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_full_context", arguments: {} },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("get_full_context: includes time, date, sinceLastCheck, and session", () => {
      assert.ok(typeof parsed.time === "string");
      assert.ok(typeof parsed.date === "string");
      assert.ok(typeof parsed.sinceLastCheck === "object");
      assert.ok(typeof parsed.session === "object");
    });
    check("get_full_context: sinceLastCheck reports firstCheck true on a fresh process", () => {
      assert.strictEqual(parsed.sinceLastCheck.firstCheck, true);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_full_context",
        arguments: { gap_threshold_minutes: -10 },
      },
    });
    const res = await waitFor(2);
    const parsed = JSON.parse(res.result.content[0].text);
    check("get_full_context: negative gap_threshold_minutes returns an error, not a crash or silent default", () => {
      assert.strictEqual(parsed.error, "gap_threshold_minutes must be zero or positive");
    });
  });

  // --- Conversation scoping ---

  const CONV_A = `test-a-${Date.now()}`;
  const CONV_B = `test-b-${Date.now()}`;

  await runServerTest(async ({ send, waitFor }) => {
    // Two conversations inside ONE server process must not see each
    // other's clock. This is the original bug, inverted into a test.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_full_context", arguments: { conversation_id: CONV_A } },
    });
    const a = JSON.parse((await waitFor(2)).result.content[0].text);
    check("conversation scoping: first call in conversation A reports firstCheck true", () => {
      assert.strictEqual(a.sinceLastCheck.firstCheck, true);
    });

    await new Promise((r) => setTimeout(r, 100));
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_full_context", arguments: { conversation_id: CONV_B } },
    });
    const b = JSON.parse((await waitFor(3)).result.content[0].text);
    check("conversation scoping: a different conversation in the same process is unaffected by A", () => {
      assert.strictEqual(b.sinceLastCheck.firstCheck, true);
    });
    check("conversation scoping: conversation B session duration is ~0, not A's elapsed time", () => {
      assert.ok(b.session.durationMs < 50, `expected <50ms, got ${b.session.durationMs}`);
    });

    await new Promise((r) => setTimeout(r, 100));
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_full_context", arguments: { conversation_id: CONV_A } },
    });
    const a2 = JSON.parse((await waitFor(4)).result.content[0].text);
    check("conversation scoping: returning to conversation A resumes A's own clock", () => {
      assert.strictEqual(a2.sinceLastCheck.firstCheck, false);
      assert.ok(a2.session.durationMs >= 180, `expected >=180ms, got ${a2.session.durationMs}`);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    // A DIFFERENT process must still recognise conversation A. Under the
    // old PID-keyed layout this was impossible by construction.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_full_context", arguments: { conversation_id: CONV_A } },
    });
    const parsed = JSON.parse((await waitFor(2)).result.content[0].text);
    check("conversation scoping: conversation state survives a server restart", () => {
      assert.strictEqual(parsed.sinceLastCheck.firstCheck, false);
    });
    check("conversation scoping: a scoped call carries no fallback warning", () => {
      assert.strictEqual(parsed.warning, undefined);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_full_context", arguments: {} },
    });
    const parsed = JSON.parse((await waitFor(2)).result.content[0].text);
    check("fallback: omitting conversation_id returns an explicit warning", () => {
      assert.ok(
        typeof parsed.warning === "string" && parsed.warning.includes("conversation_id"),
        `expected a warning mentioning conversation_id, got ${JSON.stringify(parsed.warning)}`
      );
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    // conversation_id becomes a filename, so traversal and separator
    // characters must be rejected outright rather than sanitized.
    for (const [id, bad] of [
      [2, "../../escape"],
      [3, ".."],
      [4, "has/slash"],
      [5, "way-too-long".repeat(10)],
    ]) {
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get_full_context", arguments: { conversation_id: bad } },
      });
      const parsed = JSON.parse((await waitFor(id)).result.content[0].text);
      check(`conversation_id validation rejects ${JSON.stringify(bad).slice(0, 24)}`, () => {
        assert.ok(typeof parsed.error === "string", `expected an error for ${bad}`);
      });
    }
  });

  await runServerTest(async ({ send, waitFor }) => {
    // Regression test for the sessionStart hole: get_time_since_last_check
    // used to write lastCheck without ever initializing sessionStart, so a
    // later get_session_duration would reset the clock and under-report.
    const conv = `test-hole-${Date.now()}`;
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_time_since_last_check", arguments: { conversation_id: conv } },
    });
    await waitFor(2);

    await new Promise((r) => setTimeout(r, 200));
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_session_duration", arguments: { conversation_id: conv } },
    });
    const parsed = JSON.parse((await waitFor(3)).result.content[0].text);
    check("get_time_since_last_check initializes sessionStart (no premature reset)", () => {
      assert.ok(
        parsed.sessionDurationMs >= 180,
        `expected session to run from the first call (>=180ms), got ${parsed.sessionDurationMs}`
      );
    });
    check("get_session_duration does not re-flag a session already started", () => {
      assert.strictEqual(parsed.newSessionDetected, false);
    });
  });

  await runServerTest(async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });
    const res = await waitFor(2);
    check("calling an unknown tool returns a JSON-RPC error, not a crash", () => {
      assert.ok(res.error && typeof res.error.message === "string");
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
