/**
 * Lifecycle manager for OpenChamber-managed Docker OpenCode instances.
 *
 * Owns the explicit state machine:
 *   creating → starting → probing → running ⇄ stopped → removing → gone
 * with `error` and `removal-failed` as parked states, and journal-driven
 * rollback: every resource the create flow brings into existence is written
 * to the record's journal BEFORE the next step runs, so a failure at any
 * point removes exactly what this operation created — never another
 * instance's container, never user Docker resources (the journal plus the
 * `openchamber.instance` label are the only addressing mechanisms).
 *
 * The active upstream is an in-memory pointer (origin + instance mapping)
 * set through `setActiveInstance()`; the registry persists the pointer id so
 * it can be restored at startup after the container is re-verified. When a
 * Docker instance is active, `getActiveUpstream()` feeds the network runtime
 * and the instance's mapping feeds the path-mapping bridge; deactivating
 * restores the pre-existing Local/external behavior unchanged.
 */

import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { OPENCHAMBER_INSTANCE_LABEL } from '../../docker/runtime.js';
import { buildInstanceMounts, CONTAINER_OPENCODE_PORT } from './mounts.js';
import { createInstancePathMapping, setActiveInstancePathMapping } from '../path-mapping.js';

const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_READINESS_INTERVAL_MS = 500;

const createDefaultHealthProbe = () => async (origin) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${String(origin).replace(/\/+$/, '')}/global/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const createDefaultFreePortFinder = () => () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

export const createDockerInstanceLifecycleManager = (options = {}) => {
  const {
    runtime,
    store,
    logger = console,
    defaultImage = 'opencode-instance:local',
    platform = process.platform,
    probeHealth = createDefaultHealthProbe(),
    getFreePort = createDefaultFreePortFinder(),
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    readinessIntervalMs = DEFAULT_READINESS_INTERVAL_MS,
    onActiveUpstreamChanged = null,
  } = options;

  // In-memory active upstream; sync reads for the network runtime hot path.
  let activeUpstream = null;
  // Workspace of the active instance, captured for deactivate-time side
  // effects (project restore/withdrawal) after the pointer is cleared.
  let activeWorkspaceHostPath = null;

  const fail = (code, message, extra = {}) => {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
  };

  const isContainerMissingError = (error) => /no such container/i.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);

  const instanceOrigin = (record) => `http://127.0.0.1:${record.port}`;

  /**
   * Bounded container log tail for failure diagnostics. Captured BEFORE any
   * rollback removes the container; an unavailable log tail is not an error —
   * diagnosability is best-effort by design.
   */
  const captureContainerLogs = async (containerId) => {
    if (!containerId) return '';
    try {
      return (await runtime.containerLogs(containerId, { tail: 200 }) ?? '').slice(-2000);
    } catch {
      return '';
    }
  };

  /**
   * Removes every journaled container. Returns the entries that could not be
   * removed (already-gone containers count as removed, never as failures) so
   * callers decide between best-effort create rollback and authoritative
   * cleanup that must park `removal-failed`.
   */
  const removeJournaledContainers = async (journal) => {
    const failures = [];
    for (const entry of [...journal].reverse()) {
      if (entry.type !== 'container') continue;
      try {
        await runtime.removeContainer(entry.ref, { force: true });
      } catch (error) {
        if (!isContainerMissingError(error)) {
          logger.warn?.(`[docker-instances] Could not remove container ${entry.ref}: ${error.message}`);
          failures.push({ ref: entry.ref, error });
        }
      }
    }
    return failures;
  };

  const waitForHealth = async (origin) => {
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeHealth(origin)) return true;
      await new Promise((resolve) => setTimeout(resolve, readinessIntervalMs));
    }
    return false;
  };

  const requireRecord = async (id) => {
    const record = await store.get(id);
    if (!record) throw fail('NOT_FOUND', `Unknown docker instance: ${id}`);
    return record;
  };

  const createInstance = async ({
    label,
    workspaceHostPath,
    sharing = {},
    image,
    port,
    paths,
  }) => {
    const normalizedWorkspace = typeof workspaceHostPath === 'string' ? workspaceHostPath.trim() : '';
    const isAbsolute = platform === 'win32'
      ? /^[a-zA-Z]:[\\/]/.test(normalizedWorkspace) || /^\\\\/.test(normalizedWorkspace)
      : normalizedWorkspace.startsWith('/');
    if (!normalizedWorkspace || !isAbsolute) {
      throw fail('INVALID_WORKSPACE', `Workspace path must be an absolute path on this platform (got ${JSON.stringify(workspaceHostPath)})`);
    }

    const id = `docker-${randomUUID().slice(0, 8)}`;
    const effectiveImage = typeof image === 'string' && image.trim() ? image.trim() : defaultImage;
    const containerName = `openchamber-opencode-${id}`;
    const fallbackLabel = normalizedWorkspace.split(/[\\/]/).filter(Boolean).pop() || id;
    const now = Date.now();
    // Local journal mirror: the store is authoritative, this array is what
    // the catch block rolls back without re-reading.
    const journal = [];

    const record = await store.upsert({
      id,
      label: typeof label === 'string' && label.trim() ? label.trim() : fallbackLabel,
      image: effectiveImage,
      containerId: null,
      containerName,
      port: null,
      workspaceHostPath: normalizedWorkspace,
      workspaceContainerPath: '/workspace',
      mappingRules: [{ hostPrefix: normalizedWorkspace, remotePrefix: '/workspace' }],
      sharing: {
        config: sharing.config === true,
        skills: sharing.skills === true,
        credentials: sharing.credentials === true,
        skillsHostDir: typeof sharing.skillsHostDir === 'string' && sharing.skillsHostDir.trim()
          ? sharing.skillsHostDir.trim()
          : null,
      },
      lifecycleState: 'creating',
      lastError: null,
      resourceJournal: [],
      createdAt: now,
      updatedAt: now,
    });

    try {
      if (!await runtime.imageExists(effectiveImage)) {
        throw fail('IMAGE_MISSING', `Image ${effectiveImage} is not available locally. Build or pull it explicitly first.`);
      }

      const effectivePort = Number.isSafeInteger(port) && port > 0 ? port : await getFreePort();

      let mounts;
      try {
        mounts = buildInstanceMounts({ instance: record, paths });
      } catch (error) {
        throw fail('INVALID_MOUNTS', error.message);
      }

      const containerId = await runtime.createContainer({
        name: containerName,
        image: effectiveImage,
        labels: { [OPENCHAMBER_INSTANCE_LABEL]: id },
        env: {},
        binds: mounts,
        portBindings: { [`${CONTAINER_OPENCODE_PORT}/tcp`]: { hostIp: '127.0.0.1', hostPort: effectivePort } },
      });

      // Journal BEFORE the next step: everything past this point rolls the
      // container back through the journal, never by guessing.
      journal.push({ type: 'container', ref: containerId });
      await store.update(id, (current) => ({
        ...current,
        containerId,
        port: effectivePort,
        resourceJournal: [...current.resourceJournal, { type: 'container', ref: containerId }],
        lifecycleState: 'starting',
      }));

      try {
        await runtime.startContainer(containerId);
      } catch (error) {
        throw fail('START_FAILED', `Container start failed: ${error.message}`);
      }

      await store.update(id, (current) => ({ ...current, lifecycleState: 'probing' }));

      const origin = `http://127.0.0.1:${effectivePort}`;
      if (!await waitForHealth(origin)) {
        throw fail('READINESS_TIMEOUT', `OpenCode inside the container did not become ready within ${Math.round(readinessTimeoutMs / 1000)}s`);
      }

      return store.update(id, (current) => ({ ...current, lifecycleState: 'running', lastError: null }));
    } catch (error) {
      // Creation failed: capture the container's logs first (rollback removes
      // it), then remove exactly this operation's resources. When the
      // rollback itself is clean the record is dropped, so the selector never
      // lists a broken instance; a partially-failed rollback parks the record
      // in `removal-failed` with its journal so cleanup can be retried.
      const journaledContainer = journal.find((entry) => entry.type === 'container')?.ref ?? null;
      error.containerLogTail = await captureContainerLogs(journaledContainer);
      const failures = await removeJournaledContainers(journal);
      if (failures.length === 0) {
        await store.remove(id);
        error.cleanedUp = true;
      } else {
        await store.update(id, (current) => ({
          ...current,
          lifecycleState: 'removal-failed',
          lastError: `Creation rolled back with cleanup failures on ${failures.map((entry) => entry.ref).join(', ')}`,
        }));
        error.cleanedUp = false;
      }
      throw error;
    }
  };

  const startInstance = async (id) => {
    const record = await requireRecord(id);
    if (record.lifecycleState === 'running') return record;
    if (!record.containerId) throw fail('NO_CONTAINER', 'Instance has no container to start');

    await store.update(id, (current) => ({ ...current, lifecycleState: 'starting', lastError: null }));
    try {
      await runtime.startContainer(record.containerId);
    } catch (error) {
      const message = isContainerMissingError(error) ? 'Container no longer exists' : `Container start failed: ${error.message}`;
      const parked = await store.update(id, (current) => ({
        ...current,
        lifecycleState: 'error',
        lastError: message,
      }));
      throw fail(isContainerMissingError(error) ? 'CONTAINER_MISSING' : 'START_FAILED', message, { record: parked });
    }

    await store.update(id, (current) => ({ ...current, lifecycleState: 'probing' }));
    if (!await waitForHealth(instanceOrigin(record))) {
      const logTail = await captureContainerLogs(record.containerId);
      const message = logTail
        ? `OpenCode did not become ready after start. Container log tail: ${logTail}`
        : 'OpenCode did not become ready after start';
      const parked = await store.update(id, (current) => ({
        ...current,
        lifecycleState: 'error',
        lastError: message.slice(0, 500),
      }));
      throw fail('READINESS_TIMEOUT', message, { record: parked, containerLogTail: logTail });
    }
    return store.update(id, (current) => ({ ...current, lifecycleState: 'running', lastError: null }));
  };

  const stopInstance = async (id, { timeoutSeconds = 10 } = {}) => {
    const record = await requireRecord(id);
    if (record.lifecycleState === 'stopped') return record;
    if (!record.containerId) {
      return store.update(id, (current) => ({ ...current, lifecycleState: 'stopped' }));
    }

    try {
      await runtime.stopContainer(record.containerId, { timeoutSeconds });
    } catch (error) {
      if (!isContainerMissingError(error)) {
        const parked = await store.update(id, (current) => ({
          ...current,
          lifecycleState: 'error',
          lastError: `Stop failed: ${error.message}`,
        }));
        throw fail('STOP_FAILED', `Stop failed: ${error.message}`, { record: parked });
      }
      // A container that vanished externally is as good as stopped.
    }
    return store.update(id, (current) => ({ ...current, lifecycleState: 'stopped', lastError: null }));
  };

  /**
   * Removes every journaled resource and the record itself. Idempotent:
   * already-gone resources are successes, failures keep the record parked in
   * `removal-failed` with its journal so cleanup can be retried.
   */
  const cleanupInstance = async (id) => {
    const record = await requireRecord(id);
    await store.update(id, (current) => ({ ...current, lifecycleState: 'removing' }));

    const failures = await removeJournaledContainers(record.resourceJournal);
    if (failures.length > 0) {
      const parked = await store.update(id, (current) => ({
        ...current,
        lifecycleState: 'removal-failed',
        lastError: `Cleanup failed on ${failures.map((entry) => entry.ref).join(', ')}`,
      }));
      throw fail('CLEANUP_FAILED', `Cleanup failed: ${failures[0].error.message}`, { record: parked });
    }

    const wasActive = activeUpstream?.instanceId === id
      || (await store.getActiveInstanceId()) === id;
    await store.remove(id);
    if (wasActive) {
      await deactivate();
    }
    return { removed: true };
  };

  const removeInstance = async (id, { force = false } = {}) => {
    const record = await requireRecord(id);
    if (record.lifecycleState === 'running' && record.containerId && !force) {
      await stopInstance(id);
    } else if (record.lifecycleState === 'running' && record.containerId) {
      try {
        await runtime.stopContainer(record.containerId, { timeoutSeconds: 2 });
      } catch {
        // Forced removal removes a running container directly below.
      }
    }
    return cleanupInstance(id);
  };

  const deactivate = async () => {
    const workspaceHostPath = activeWorkspaceHostPath;
    const previousWasDocker = activeUpstream !== null;
    activeUpstream = null;
    activeWorkspaceHostPath = null;
    setActiveInstancePathMapping(null);
    await store.setActiveInstanceId(null);
    // Awaited so side effects (settings persistence, project restore or
    // withdrawal) complete before the caller's API response reaches the UI.
    await onActiveUpstreamChanged?.(null, { workspaceHostPath, previousWasDocker });
  };

  const setActiveInstance = async (id) => {
    if (id === null || id === undefined) {
      await deactivate();
      return null;
    }
    const record = await requireRecord(id);
    if (record.lifecycleState !== 'running' || !record.port) {
      throw fail('NOT_CONNECTABLE', `Instance ${id} is not connectable (state: ${record.lifecycleState})`, {
        currentState: record.lifecycleState,
        canStart: ['stopped', 'error'].includes(record.lifecycleState),
      });
    }

    // Workspace-fallback mapping: unmapped host directories (e.g. OpenChamber's
    // default project dir) land at the container's workspace root instead of
    // reaching the Linux container as meaningless relative paths.
    const mapping = createInstancePathMapping({
      rules: record.mappingRules,
      fallbackRemote: record.workspaceContainerPath || '/workspace',
      platform,
    });
    const previousWasDocker = activeUpstream !== null;
    activeUpstream = { instanceId: id, origin: instanceOrigin(record) };
    activeWorkspaceHostPath = record.workspaceHostPath;
    setActiveInstancePathMapping(mapping);
    await store.setActiveInstanceId(id);
    await onActiveUpstreamChanged?.(activeUpstream, { workspaceHostPath: record.workspaceHostPath, previousWasDocker });
    return activeUpstream;
  };

  const getActiveUpstream = () => activeUpstream;

  /**
   * Startup restore: re-activate only what the daemon still confirms. A
   * stale pointer degrades to the default upstream instead of poisoning
   * every OpenCode-bound request.
   */
const restoreActiveInstance = async ({ isFeatureEnabled = null } = {}) => {
  const activeId = await store.getActiveInstanceId();
  if (!activeId) return null;
  // The feature toggle is authoritative: with it off, a persisted pointer
  // must degrade to the default upstream (the routes would refuse to touch
  // the instance, so the pointer could never be cleared otherwise).
  if (typeof isFeatureEnabled === 'function' && !(await isFeatureEnabled())) {
    await deactivate();
    return null;
  }
  const record = await store.get(activeId);
  if (!record || record.lifecycleState !== 'running' || !record.containerId || !record.port) {
    await deactivate();
    return null;
  }
    let running = false;
    try {
      const inspected = await runtime.inspectContainer(record.containerId);
      running = inspected?.State?.Running === true;
    } catch {
      running = false;
    }
    if (!running) {
      await store.update(activeId, (current) => ({ ...current, lifecycleState: 'stopped' }));
      await deactivate();
      return null;
    }
    await setActiveInstance(activeId);
    return activeUpstream;
  };

  const listInstances = () => store.list();

  const getInstanceStatus = async (id) => {
    const record = await requireRecord(id);
    const healthy = record.lifecycleState === 'running' && record.port
      ? await probeHealth(instanceOrigin(record))
      : false;
    return {
      ...record,
      connectable: record.lifecycleState === 'running' && Boolean(record.port),
      healthy,
    };
  };

  return {
    createInstance,
    startInstance,
    stopInstance,
    removeInstance,
    cleanupInstance,
    setActiveInstance,
    deactivate,
    getActiveUpstream,
    getActiveInstanceId: () => store.getActiveInstanceId(),
    restoreActiveInstance,
    listInstances,
    getInstanceStatus,
  };
};
