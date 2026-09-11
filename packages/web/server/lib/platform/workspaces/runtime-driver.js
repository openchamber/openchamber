// Runtime driver interface (plan section 8.1 steps 4-7) and driver resolution.
//
// A runtime driver owns the actual user execution environment (eventually a
// Docker container on the Linux host). The platform API and the runtime
// worker only ever talk to this interface:
//
//   ensureWorkspace({workspace, generation, userBinding}) -> {endpoint, runtimeId}
//     Idempotently guarantee a RUNNING environment for the workspace at the
//     given generation. A driver must:
//       - return the existing runtime when it already serves this generation
//         (or a newer one) - repeated calls never create duplicates;
//       - replace any runtime of an OLDER generation (rebuild: stop old
//         generation, keep data, start new generation - plan section 8.2);
//       - throw, without acquiring capacity, when capacity is exhausted
//         (error code 'capacity_exhausted', plan section 11.2);
//       - throw a locatable error on any other failure.
//     `endpoint` is internal-only and must never be exposed via platform APIs
//     (plan section 7.3).
//
//   stopWorkspace({workspace, generation, reason}) -> {stopped: true}
//     Graceful-first stop of the workspace runtime (plan section 8.5); the
//     driver applies its own force-kill policy after the graceful timeout.
//     Stopping a workspace with no running runtime is a no-op success.
//
//   inspectWorkspace({workspace}) -> {state, activeTasks}
//     Cheap observation for reconciliation and admin views: driver-level
//     state plus the number of active tasks (needed for the admin-stop
//     confirmation, plan section 8.5).
//
// Driver errors MUST carry a stable, locatable `code` property; the worker
// persists it as runtime_operations.error_code and workspaces.last_error.
//
// Resolution: OPENCHAMBER_RUNTIME_DRIVER=fake|docker (default: fake).
// The docker driver does NOT exist in this environment: it throws honestly
// instead of pretending (real container runtime lands on the Linux host,
// plan section 12.1 - macOS dev cannot replace Linux UID/GID, network
// isolation and gVisor acceptance).

export function createDockerRuntimeDriver() {
  const error = new Error(
    'docker runtime driver is not implemented in this environment - pending Linux host',
  );
  error.code = 'driver_not_implemented';
  throw error;
}

// Fake driver: simulates the lifecycle in memory for development and tests.
// It enforces a hard max-concurrent capacity counter (plan section 11.2,
// initial global capacity 5) and exposes hooks so tests can inject failure
// (throw from beforeEnsure/beforeStop) or stalls (sleep inside a hook).
export function createFakeRuntimeDriver({ maxConcurrent = 5, hooks = {} } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('createFakeRuntimeDriver requires maxConcurrent >= 1');
  }
  // workspaceId -> {generation, runtimeId, endpoint}
  const runtimes = new Map();
  let sequence = 0;

  async function ensureWorkspace({ workspace, generation }) {
    if (typeof hooks.beforeEnsure === 'function') {
      await hooks.beforeEnsure({ workspace, generation });
    }
    const existing = runtimes.get(workspace.id);
    if (existing && existing.generation >= generation) {
      // Same or newer generation already running: idempotent no-op.
      return { endpoint: existing.endpoint, runtimeId: existing.runtimeId };
    }
    if (existing) {
      // Older generation: rebuild semantics - release the old runtime first.
      runtimes.delete(workspace.id);
    }
    if (runtimes.size >= maxConcurrent) {
      const error = new Error(
        `fake runtime capacity exhausted (max ${maxConcurrent} concurrent workspaces)`,
      );
      error.code = 'capacity_exhausted';
      throw error;
    }
    sequence += 1;
    const runtimeId = `fake-${workspace.id}-g${generation}-${sequence}`;
    const endpoint = `fake://runtime/${runtimeId}`;
    runtimes.set(workspace.id, { generation, runtimeId, endpoint });
    return { endpoint, runtimeId };
  }

  async function stopWorkspace({ workspace, generation, reason }) {
    if (typeof hooks.beforeStop === 'function') {
      await hooks.beforeStop({ workspace, generation, reason });
    }
    runtimes.delete(workspace.id);
    return { stopped: true };
  }

  async function inspectWorkspace({ workspace }) {
    if (typeof hooks.inspect === 'function') {
      return hooks.inspect({ workspace });
    }
    const runtime = runtimes.get(workspace.id);
    return runtime
      ? { state: 'running', activeTasks: 0 }
      : { state: 'stopped', activeTasks: 0 };
  }

  return {
    name: 'fake',
    ensureWorkspace,
    stopWorkspace,
    inspectWorkspace,
    // Test/dev introspection: currently consumed capacity slots.
    activeCount: () => runtimes.size,
  };
}

export function resolveRuntimeDriver({ env = process.env, maxConcurrent } = {}) {
  const kind = env.OPENCHAMBER_RUNTIME_DRIVER || 'fake';
  if (kind === 'docker') {
    return createDockerRuntimeDriver();
  }
  if (kind === 'fake') {
    const limit = Number.isInteger(Number(env.OPENCHAMBER_RUNTIME_MAX_CONCURRENT))
      && Number(env.OPENCHAMBER_RUNTIME_MAX_CONCURRENT) > 0
      ? Number(env.OPENCHAMBER_RUNTIME_MAX_CONCURRENT)
      : maxConcurrent ?? 5;
    return createFakeRuntimeDriver({ maxConcurrent: limit });
  }
  throw new Error(`unknown OPENCHAMBER_RUNTIME_DRIVER "${kind}" (expected "fake" or "docker")`);
}

// Default export resolves the driver from the process environment; the worker
// entry point uses this. Tests inject createFakeRuntimeDriver directly.
export default function defaultRuntimeDriver(options = {}) {
  return resolveRuntimeDriver({ env: process.env, ...options });
}
