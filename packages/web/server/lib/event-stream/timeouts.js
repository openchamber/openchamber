// The three timing windows of the event stream, and the environment variables that override them.
// The stall window is how long an attached upstream SSE read may stay silent before it is reconnected.
// The concurrent window applies while more than one session is active. The resume idle bound is how
// long a catch-up read may stay silent before its client is taken as caught up with OpenCode.

// OpenCode 2.x writes `: heartbeat` on an idle event stream every 15 s (opencode
// packages/server/src/handlers/event.ts, `Stream.tick("15 seconds")`). A stall window at or below
// this tears down and reopens every idle stream: at 10 s it did so every ~10.25 s, which was about
// 80% of OpenChamber's log lines (dezren39/nix#668). Keep the stall window above it with margin.
export const OPENCODE_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = 2 * DEFAULT_UPSTREAM_STALL_TIMEOUT_MS;
export const DEFAULT_RESUME_IDLE_TIMEOUT_MS = 10_000;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

const TIMEOUT_SETTINGS = [
  { key: 'stallTimeoutMs', env: 'OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS', fallback: DEFAULT_UPSTREAM_STALL_TIMEOUT_MS },
  { key: 'concurrentStallTimeoutMs', env: 'OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS', fallback: UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS },
  { key: 'resumeIdleTimeoutMs', env: 'OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS', fallback: DEFAULT_RESUME_IDLE_TIMEOUT_MS },
];

// Each value is a whole number of milliseconds within the bounds. Anything else keeps that window's
// default, with a warning, rather than running with a guessed value.
function resolveTimeoutSetting({ env: name, fallback }, env, warn) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    warn(`[event-stream] Ignoring ${name}=${JSON.stringify(raw)}: expected ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} ms`);
    return fallback;
  }
  return value;
}

/**
 * Reads the three windows from the environment. Returns `{ stallTimeoutMs, concurrentStallTimeoutMs,
 * resumeIdleTimeoutMs }`, each a whole number of milliseconds.
 */
export function resolveEventStreamTimeouts(env = process.env, warn = console.warn) {
  const resolved = {};
  for (const setting of TIMEOUT_SETTINGS) {
    resolved[setting.key] = resolveTimeoutSetting(setting, env, warn);
  }
  return resolved;
}
