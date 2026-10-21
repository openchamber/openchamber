// The three timing windows of the event stream, and the environment variables that override them.
// The stall window is how long an attached upstream SSE read may stay silent before it is reconnected.
// The concurrent window applies while more than one session is active. The resume idle bound is how
// long a catch-up read may stay silent before its client is taken as caught up with OpenCode.
//
// A stall window must outlast the heartbeat of the stream it watches, or it reconnects that stream
// every window while nothing happens. OpenCode 2.x writes a heartbeat comment every 15 s
// (packages/server/src/handlers/event.ts), and the control and notification streams read inside a
// space write theirs every 25 and 20 s. With windows of 10 and 20 s, a quiet OpenCode stream was
// reconnected every 10 s; each reconnect reached the browsers as a `ready` frame and OpenCode's
// `server.connected` greeting, and the UI answered the greeting by re-reading what it shows.

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = 3 * DEFAULT_UPSTREAM_STALL_TIMEOUT_MS;
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
  const value = Number(raw);
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
