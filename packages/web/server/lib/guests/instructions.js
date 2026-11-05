import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What extension services asked agents to read (`contributes.instructions`).
 * Kept beside `extensions.json`, because the send path reads it before every
 * message and a service may be stopped by then: no message waits on a process.
 *
 * `{ [guestId]: { [directory | GLOBAL_KEY]: text } }`.
 */

const FILE_NAME = 'guest-instructions.json';
const GLOBAL_KEY = '*';

const isInside = (directory, root) => {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** @param {{ dataDir: string, fsPromises?: typeof fs }} deps */
export const createGuestInstructions = ({ dataDir, fsPromises = fs }) => {
  const filePath = path.join(dataDir, FILE_NAME);
  let writes = Promise.resolve();

  const read = async () => {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[guest-instructions] the file could not be read:', error?.message ?? error);
      return {};
    }
  };

  const update = (change) => {
    const run = writes.then(async () => {
      const next = change(await read());
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await fsPromises.mkdir(dataDir, { recursive: true });
      await fsPromises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    });
    writes = run.catch(() => {});
    return run;
  };

  const set = (guestId, directory, text) => update((store) => {
    const key = directory === null ? GLOBAL_KEY : path.resolve(directory);
    const entries = { ...(store[guestId] ?? {}) };
    const trimmed = text.trim();
    if (trimmed) entries[key] = trimmed;
    else delete entries[key];
    const next = { ...store };
    if (Object.keys(entries).length > 0) next[guestId] = entries;
    else delete next[guestId];
    return next;
  });

  const remove = (guestId) => update((store) => {
    if (!store[guestId]) return store;
    const { [guestId]: _removed, ...rest } = store;
    return rest;
  });

  /**
   * The texts that apply to `directory`, one per approved guest: the global
   * text and those of the directory and the folders above it, narrowest last.
   * @param {string | null} directory
   * @param {Set<string>} guestIds extensions that hold the `instructions` grant now
   * @returns {Promise<Array<{ guestId: string, text: string }>>}
   */
  const forDirectory = async (directory, guestIds) => {
    if (guestIds.size === 0) return [];
    const store = await read();
    const resolved = directory ? path.resolve(directory) : null;
    const result = [];
    for (const guestId of [...guestIds].sort()) {
      const entries = store[guestId];
      if (!entries || typeof entries !== 'object') continue;
      const keys = Object.keys(entries)
        .filter((key) => key === GLOBAL_KEY || (resolved !== null && isInside(resolved, key)))
        .sort((a, b) => (a === GLOBAL_KEY ? -1 : b === GLOBAL_KEY ? 1 : a.length - b.length));
      const text = keys.map((key) => entries[key]).filter((value) => typeof value === 'string' && value).join('\n\n');
      if (text) result.push({ guestId, text });
    }
    return result;
  };

  return { set, remove, forDirectory };
};
