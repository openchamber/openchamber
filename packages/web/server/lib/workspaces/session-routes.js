import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * How many session routes are kept. Old entries are dropped least-recently-recorded
 * first; a stale route is harmless (the sidebar only consults routes for sessions that
 * still exist), so the bound only stops unbounded growth.
 */
const MAX_ROUTES = 500;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

/**
 * Server-owned record of which workspace a session was created into, and from which
 * host project directory. OpenCode exposes none of this on session reads — measured on
 * 1.18.12: directory-scoped session lists exclude workspace-routed sessions entirely,
 * the `workspace` list parameter is ignored, and the single-session response omits
 * `workspaceID` — so the association written at creation time is the only durable one a
 * UI can group by. Entries hold only identifiers and a host project directory, never
 * prompt or transcript text.
 *
 * Writes are serialized and atomic: same-directory temporary file, fsync, rename. A
 * missing or corrupt file reads as empty rather than failing the caller — losing a
 * route degrades sidebar grouping, which must never block session creation itself.
 */
export class WorkspaceSessionRouteStore {
  constructor({ rootDirectory, maxRoutes = MAX_ROUTES }) {
    this.rootDirectory = rootDirectory;
    this.file = path.join(rootDirectory, 'session-routes.json');
    this.maxRoutes = maxRoutes;
    this.queue = Promise.resolve();
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(rootDirectory, 0o700); } catch { /* not implemented everywhere */ }
  }

  async #readUnlocked() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed?.routes)) return [];
    return parsed.routes.filter((route) => route
      && typeof route === 'object'
      && SESSION_ID_PATTERN.test(route.sessionID ?? '')
      && WORKSPACE_ID_PATTERN.test(route.workspaceID ?? '')
      && typeof route.projectDirectory === 'string' && route.projectDirectory.length > 0
      && typeof route.recordedAt === 'number');
  }

  async #writeUnlocked(routes) {
    const temporary = path.join(this.rootDirectory, `.session-routes.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, routes }), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.file);
      try { await fs.promises.chmod(this.file, 0o600); } catch { /* not implemented everywhere */ }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** Records one session route; re-recording a session replaces its previous route. */
  async record({ sessionID, workspaceID, projectDirectory }) {
    if (!SESSION_ID_PATTERN.test(sessionID ?? '')) throw new Error('Session route sessionID is invalid');
    if (!WORKSPACE_ID_PATTERN.test(workspaceID ?? '')) throw new Error('Session route workspaceID is invalid');
    if (typeof projectDirectory !== 'string' || !projectDirectory.trim()) throw new Error('Session route project directory is required');
    const run = this.queue.then(async () => {
      const routes = (await this.#readUnlocked()).filter((route) => route.sessionID !== sessionID);
      routes.push({ sessionID, workspaceID, projectDirectory: projectDirectory.trim(), recordedAt: Date.now() });
      while (routes.length > this.maxRoutes) routes.shift();
      await this.#writeUnlocked(routes);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Every recorded route. Callers filter; the payload is bounded by MAX_ROUTES. */
  async routes() {
    const run = this.queue.then(() => this.#readUnlocked());
    this.queue = run.catch(() => {});
    return run;
  }
}
