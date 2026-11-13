import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { protectedSelectionReader } from './selections-reader.js';
import { readServiceState, setSubject } from './service-client.js';

const projectDocument = z.object({ identity: z.string().min(1) });

/** All common sessions share this union, including projects that are not open. */
export function agentSubjectConnections(dataDir) {
  const directory = path.join(dataDir, 'mcp-protected');
  let files;
  try { files = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const reader = protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const connections = new Set();
  for (const name of files.sort().filter((name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name))) {
    const file = path.join(directory, name);
    const identity = name === 'global.json' ? null : projectDocument.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).identity;
    const { servers } = reader.readDocument(file, identity);
    for (const entry of Object.values(servers)) if (!entry.disabled) connections.add(entry.connection);
  }
  return [...connections].sort();
}

/**
 * Re-read inside the queue so a slow older push cannot overwrite a newer selection. A push that
 * fails leaves the service with the old connections, a removed one included, so it is tried again
 * every `retryMs` until the service takes it; a later change replaces the retry. `push()` resolves
 * `{ ok: true }` or `{ ok: false, code }` for the attempt it made.
 */
export function createAgentSubjectSync({ dataDir, clientConfigPath, log = (code) => console.warn('[protected-mcp] agent_subject_sync_failed', { code }), retryMs = 10_000 }) {
  let pending = Promise.resolve();
  let retry = null;
  const attempt = async () => {
    try {
      const connections = agentSubjectConnections(dataDir);
      const result = await setSubject('agent', connections, { clientConfigPath: clientConfigPath() });
      if (result.ok) return { ok: true };
      log(result.code);
      return { ok: false, code: result.code };
    } catch (error) {
      const code = error?.code ?? 'selections_unreadable';
      log(code);
      return { ok: false, code };
    }
  };
  const push = () => {
    clearTimeout(retry);
    retry = null;
    const result = pending.then(attempt).then((answer) => {
      if (!answer.ok && retry === null) {
        retry = setTimeout(() => { retry = null; void push(); }, retryMs);
        retry.unref?.();
      }
      return answer;
    });
    pending = result.catch(() => {});
    return result;
  };
  return {
    push,
    async start() {
      try {
        const state = await readServiceState({ clientConfigPath: clientConfigPath() });
        if (state.state === 'available') await push();
      } catch (error) {
        log(error?.code ?? 'service_unavailable');
      }
    },
    stop() { clearTimeout(retry); retry = null; },
  };
}
