import fs from 'node:fs/promises';
import path from 'node:path';
import { createEngineSocketServer } from './engine-socket.js';
import { ensurePrivateDirectory, StateDurabilityError } from './state-files.js';
import { parseSubject } from './subject-contract.js';

/** Directory inodes outlive every listener, including removal and recreation. */
export function createSubjectListeners({ subjectsDir, store, sessions, log }) {
  const listeners = new Map();
  let pending = Promise.resolve();
  const serialized = (work) => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  const ensure = (subject) => {
    parseSubject(subject);
    if (listeners.has(subject)) return listeners.get(subject);
    const starting = (async () => {
      await ensurePrivateDirectory(subjectsDir);
      const directory = path.join(subjectsDir, subject);
      await fs.mkdir(directory, { mode: 0o711 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      await fs.chmod(directory, 0o711);
      const listener = createEngineSocketServer({ path: path.join(directory, 'engine.sock'), subject, store, sessions, log });
      try { await listener.listen(); }
      catch (error) { await listener.close(); throw error; }
      return listener;
    })();
    listeners.set(subject, starting);
    starting.catch(() => listeners.delete(subject));
    return starting;
  };
  const drop = async (subject) => {
    const listener = listeners.get(subject);
    if (listener) await (await listener).close();
    listeners.delete(subject);
  };
  return {
    set: (subject, connections) => serialized(async () => {
      const existed = listeners.has(subject);
      await ensure(subject);
      try { return await store.setSubject(subject, connections); }
      catch (error) { if (!existed && !(error instanceof StateDurabilityError)) await drop(subject); throw error; }
    }),
    remove: (subject) => serialized(async () => {
      try { await store.removeSubject(subject); }
      catch (error) { if (error instanceof StateDurabilityError) await drop(subject); throw error; }
      await drop(subject);
    }),
    async start() {
      await ensurePrivateDirectory(subjectsDir);
      for (const { subject } of store.subjects()) await ensure(subject);
    },
    async close() {
      await pending;
      const closing = [...listeners.values()];
      listeners.clear();
      await Promise.all(closing.map(async (listener) => (await listener.catch(() => null))?.close()));
    },
  };
}
