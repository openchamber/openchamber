import fs from 'node:fs/promises';
import path from 'node:path';
import { isString } from '../../shared/guards.js';
import { createAdminSocketServer } from './admin-socket.js';
import { toPublicStatus } from './contract.js';
import { createEngineSocketServer } from './engine-socket.js';
import { startHttpUpstream } from './http-upstream.js';
import { createIntegrity } from './integrity.js';
import { createFallbackBackend, createSessionManager, unavailableMessage } from './mcp-session.js';
import { createOAuth } from './oauth.js';
import { createRuntimes } from './runtimes.js';
import { startStdioUpstream } from './stdio-upstream.js';
import { openStore } from './store.js';
import { createSubjectListeners } from './subject-listeners.js';

const ENFORCEMENT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_WORKER_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * The protected service: its state, the engine socket, the admin socket and
 * the workers, wired together. `main.js` builds it from the installed
 * configuration; tests build it over temporary directories.
 */
export async function createProtectedMcpService({
  version,
  stateDir,
  engineSocketPath,
  engineSocketGroup = null,
  subjectsDir = path.join(path.dirname(engineSocketPath), 'subjects'),
  adminSocketPath,
  adminSocketGroup = null,
  integrity: integrityOptions,
  enforcement,
  workerPath = DEFAULT_WORKER_PATH,
  npmCommand = null,
  now = Date.now,
  fetchImpl = fetch,
  log = () => {},
}) {
  let sessions = null;
  let runtimes = null;
  const store = await openStore({
    stateDir,
    onSubjectChange: (subject, allowed) => sessions.restrictSubject(subject, allowed),
    onChange: (id, { restart }) => {
      if (restart) sessions?.endConnection(id);
      // A newly approved package is installed right away, not at the first call.
      const definition = store.get(id);
      if (definition?.transport === 'stdio' && !isString(definition.stdio.command)) runtimes.install(definition.stdio.command).catch(() => {});
    },
  });
  const integrity = createIntegrity(integrityOptions);
  runtimes = createRuntimes({ directory: path.join(stateDir, 'runtimes'), npmCommand, workerPath, integrity, log });
  const oauth = createOAuth({ store, fetchImpl, now, log });
  const unavailable = (definition) => (reason) => unavailableMessage({ name: definition.name, reason });

  const startBackend = async (definition) => {
    const credential = store.credentialState(definition);
    if (credential === 'missing' || credential === 'authorization_required') {
      return createFallbackBackend({ message: unavailable(definition)(credential), version });
    }
    const credentials = store.credentialsFor(definition) ?? { secrets: {}, oauth: null };
    if (definition.transport === 'http') {
      return startHttpUpstream({ definition, credentials, oauth, fetchImpl, unavailable: unavailable(definition), log });
    }
    return startStdioUpstream({ definition, credentials, store, resolveExecutable: runtimes.resolve, checkArgument: integrity.checkArgument, workerPath, log });
  };
  sessions = createSessionManager({ store, startBackend, version, log });

  let enforcementState = { status: 'unverified', checkedAt: 0, findings: [{ code: 'not_checked', level: 'unknown' }] };
  const refreshEnforcement = async () => {
    try {
      enforcementState = await enforcement();
    } catch {
      enforcementState = { status: 'unverified', checkedAt: now(), findings: [{ code: 'preflight_failed', level: 'unknown' }] };
    }
  };
  const status = () => toPublicStatus({ version, administration: enforcementState.administration ?? 'shared', enforcement: enforcementState, connections: store.list() });
  // Settings shows whether a package the service installs is ready to run.
  const views = () => Promise.all(store.adminViews().map(async (view) => (view.transport === 'stdio'
    ? { ...view, runtime: await runtimes.status(view.stdio.command) }
    : view)));
  const subjectListeners = createSubjectListeners({ subjectsDir, store, sessions, log });
  const adminServer = createAdminSocketServer({ path: adminSocketPath, group: adminSocketGroup, store, status, views, oauth, subjectListeners, log });
  const engineServer = createEngineSocketServer({ path: engineSocketPath, group: engineSocketGroup, store, status, sessions, log });
  let timer = null;

  return {
    async start() {
      // No worker runs yet: secret files a crashed run left behind are deleted.
      for (const { definition } of store.list()) {
        await fs.rm(path.join(stateDir, 'connections', definition.id, 'secrets'), { recursive: true, force: true });
      }
      try {
        await engineServer.listen();
        await subjectListeners.start();
        await adminServer.listen();
      } catch (error) {
        await Promise.all([engineServer.close(), adminServer.close(), subjectListeners.close()]);
        await store.close();
        throw error;
      }
      await refreshEnforcement();
      for (const { definition } of store.list()) {
        if (definition.transport === 'stdio' && await runtimes.status(definition.stdio.command) === 'missing') runtimes.install(definition.stdio.command).catch(() => {});
      }
      timer = setInterval(refreshEnforcement, ENFORCEMENT_INTERVAL_MS);
      timer.unref();
      log('service_started', { status: enforcementState.status });
    },
    async close() {
      clearInterval(timer);
      // The listener waits for its sockets, so sessions are ended before waiting on it.
      const listenerClosed = engineServer.close();
      const adminClosed = adminServer.close();
      await adminClosed;
      const subjectsClosed = subjectListeners.close();
      sessions.closeAll();
      await listenerClosed;
      await subjectsClosed;
      await store.close();
    },
    refreshEnforcement,
    status,
    sessions,
    runtimes,
  };
}
