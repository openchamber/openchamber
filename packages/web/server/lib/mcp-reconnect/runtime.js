import { pathToFileURL } from 'node:url';
import { appendManagedPlugin } from '../opencode/managed-plugin-config.js';

/**
 * OpenCode marks an MCP server `failed` when it does not come up at startup or
 * when a live connection drops, and never tries again. This plugin runs inside
 * the managed OpenCode process and reconnects those servers with a per-server
 * exponential backoff, so a server that was merely slow to start, or a local
 * one that crashed, comes back without an OpenCode restart.
 *
 * Only `failed` is retried. `needs_auth`, `needs_client_registration`, and
 * `disabled` are user decisions or need user action, and retrying them would
 * either loop on a login prompt or re-enable a server the user turned off.
 *
 * The plugin talks to OpenCode through the SDK client OpenCode hands it, which
 * is scoped to one project directory, so each open directory reconnects its
 * own servers. Reconnecting spawns a child process per server, so the loop is
 * bounded from every direction that multiplies it: a per-server attempt cap,
 * a per-process concurrency budget shared across directory instances, and
 * jitter so instances retry out of phase. OpenCode reports each failed
 * attempt; the plugin adds one warning when it gives up on a server, because
 * OpenCode never reports that decision.
 *
 * The plugin stays passive until its directory emits the first
 * `mcp.tools.changed` event. Reading MCP status initializes that directory's
 * MCP servers as a side effect, and OpenChamber creates an instance for every
 * known project and chat directory at startup, so a plugin that polled from
 * the moment it loaded spawned the entire stdio server fleet for every
 * background instance within seconds of launch. An instance only publishes
 * `mcp.tools.changed` once its MCP is actually running, which makes that
 * event the only safe arming signal: instances nobody uses never run MCP at
 * all, and instances in use get the full reconnect behavior.
 */
const createPluginSource = () => String.raw`
const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000
const IDLE_CHECK_MS = 30000
// After this many consecutive failed attempts the server is left alone until
// it is seen healthy again or OpenCode restarts. Without a cap, a config with
// many failing stdio servers multiplied by several open directories retries
// forever and the spawned processes crowd out the machine.
const MAX_ATTEMPTS = 5
// Every reconnect spawns a child process. At most this many run at once per
// OpenCode process, shared across every directory instance, so a fleet of
// failing servers cannot stampede the process table even during startup.
const MAX_CONCURRENT_CONNECTS = 2
// Servers that did not get a connect slot are reconsidered after this long.
const SLOT_WAIT_MS = 5000
// Backoff and slot waits are jittered by up to this fraction so directory
// instances that see the same failures retry out of phase.
const JITTER_RATIO = 0.2

// Deterministic randomness for tests; the plugin source is evaluated as
// written inside OpenCode, so the seam has to travel through globalThis.
const random = typeof globalThis.__openchamberMcpReconnectTestRandom === "function"
  ? globalThis.__openchamberMcpReconnectTestRandom
  : Math.random
const jitter = (ms) => ms * (1 + (random() - 0.5) * 2 * JITTER_RATIO)

// Directory instances load their own copy of this plugin but share one
// OpenCode process, so the concurrency budget must live on globalThis.
const coordinator = globalThis.__openchamberMcpReconnectCoordinator
  ?? (globalThis.__openchamberMcpReconnectCoordinator = { inFlight: 0 })

export const OpenChamberMcpReconnectPlugin = async ({ client }) => {
  let disposed = false
  let running = false
  let wakeRequested = false
  let timer
  // Consecutive failed attempts per server, cleared once it is seen healthy.
  const attempts = new Map()
  const dueAt = new Map()

  const schedule = (delayMs) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(tick, delayMs)
  }

  const tick = async () => {
    if (running) {
      wakeRequested = true
      return
    }
    running = true
    let delay = IDLE_CHECK_MS
    try {
      const statuses = (await client.mcp.status())?.data ?? {}
      const now = Date.now()
      const due = []
      for (const [name, entry] of Object.entries(statuses)) {
        if (entry?.status !== "failed") {
          attempts.delete(name)
          dueAt.delete(name)
          continue
        }
        if ((attempts.get(name) ?? 0) >= MAX_ATTEMPTS) continue
        const at = dueAt.get(name) ?? now
        if (at > now) {
          delay = Math.min(delay, at - now)
          continue
        }
        due.push(name)
      }
      for (const name of attempts.keys()) {
        if (!Object.hasOwn(statuses, name)) {
          attempts.delete(name)
          dueAt.delete(name)
        }
      }

      // Reserve the process-wide budget synchronously — no await sits between
      // reading and raising the count — then hand the leftovers a short defer
      // that does not count as a failed attempt.
      const connectable = due.splice(0, Math.max(0, MAX_CONCURRENT_CONNECTS - coordinator.inFlight))
      coordinator.inFlight += connectable.length
      const settled = Promise.allSettled(connectable.map(async (name) => {
        try {
          await client.mcp.connect({ path: { name } })
        } finally {
          coordinator.inFlight -= 1
        }
      }))
      for (const name of due) {
        const wait = jitter(SLOT_WAIT_MS)
        dueAt.set(name, now + wait)
        delay = Math.min(delay, wait)
      }
      await settled

      // The result is read on the next tick: a server that came back clears
      // its counter there, one still failed waits out its backoff.
      const after = Date.now()
      for (const name of connectable) {
        const count = (attempts.get(name) ?? 0) + 1
        attempts.set(name, count)
        if (count >= MAX_ATTEMPTS) {
          // Give up: stop scheduling and stop waking on this server's events
          // until it is seen healthy again or leaves the config.
          dueAt.delete(name)
          console.warn("[openchamber] mcp reconnect: giving up on " + JSON.stringify(name) + " after " + MAX_ATTEMPTS + " failed attempts")
          continue
        }
        const wait = jitter(Math.min(INITIAL_RETRY_MS * 2 ** (count - 1), MAX_RETRY_MS))
        dueAt.set(name, after + wait)
        delay = Math.min(delay, wait)
      }
    } catch {
      // Status is unavailable while OpenCode is shutting down or restarting;
      // the idle check picks up again when it is back.
    } finally {
      running = false
      const wake = wakeRequested
      wakeRequested = false
      schedule(wake ? INITIAL_RETRY_MS : delay)
    }
  }

  return {
    // This event is the plugin's only arming signal and its fast path. An
    // instance publishes it only once its MCP is actually running, so a
    // background instance the user never opened stays inert instead of
    // spawning its whole server fleet; before the first event the plugin
    // makes no status call at all, because reading status initializes MCP
    // as a side effect. A dropped connection publishes the event too, which
    // beats waiting out the idle interval once armed. Events for servers
    // this plugin has given up on are ignored, so a permanently broken one
    // cannot keep waking every directory instance. An event that does not
    // name a server still wakes the loop, in case the payload shape ever
    // changes.
    event: async ({ event }) => {
      if (event?.type !== "mcp.tools.changed") return
      const server = event?.properties?.server
      if (typeof server === "string" && (attempts.get(server) ?? 0) >= MAX_ATTEMPTS) return
      schedule(INITIAL_RETRY_MS)
    },
    dispose: async () => {
      disposed = true
      clearTimeout(timer)
    },
  }
}
`;

export const createMcpReconnectRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'mcp-reconnect');
  const pluginPath = path.join(pluginDirectory, 'openchamber-mcp-reconnect-plugin.js');

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(), { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: appendManagedPlugin(rawConfig, pathToFileURL(pluginPath).href, 'MCP reconnect plugin'),
    };
  };

  return { prepareManagedOpenCodeEnv };
};
