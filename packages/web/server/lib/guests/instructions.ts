import fs from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode, hasErrorMessage, isString, isJsonObject, isJsonContainer } from './input-guards.js';
import type { JsonValue, JsonObject } from './contracts.js';

type InstructionStore = JsonObject;

const copyEntries = (value: JsonValue | undefined) => {
  if (isJsonObject(value)) return { ...value };
  if (Array.isArray(value)) return Object.fromEntries(value.map((entry, index): [string, JsonValue] => [String(index), entry]));
  if (isString(value)) return Object.fromEntries(value.split('').map((entry, index): [string, JsonValue] => [String(index), entry]));
  const empty: InstructionStore = {};
  return empty;
};

const FILE_NAME = 'guest-instructions.json';
const GLOBAL_KEY = '*';

const isInside = (directory: string, root: string) => {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const createGuestInstructions = ({ dataDir, fsPromises = fs }: { dataDir: string; fsPromises?: typeof fs }) => {
  const filePath = path.join(dataDir, FILE_NAME);
  let writes = Promise.resolve();

  const read = async (): Promise<InstructionStore> => {
    try {
      const parsed: JsonValue = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return isJsonObject(parsed) ? parsed : {};
    } catch (error) {
      if (!hasErrorCode(error) || error.code !== 'ENOENT') console.warn('[guest-instructions] the file could not be read:', hasErrorMessage(error) ? error.message ?? error : error);
      return {};
    }
  };

  const update = (change: (store: InstructionStore) => InstructionStore) => {
    const run = writes.then(async () => {
      const store = await read();
      const next = change(store);
      if (next === store) return;
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await fsPromises.mkdir(dataDir, { recursive: true });
      await fsPromises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    });
    writes = run.catch(() => {});
    return run;
  };

  const set = (guestId: string, directory: string | null, text: string) => update((store) => {
    const key = directory === null ? GLOBAL_KEY : path.resolve(directory);
    const entries = copyEntries(store[guestId]);
    const trimmed = text.trim();
    if ((entries[key] ?? '') === trimmed) return store;
    if (trimmed) entries[key] = trimmed;
    else delete entries[key];
    const next = { ...store };
    if (Object.keys(entries).length > 0) next[guestId] = entries;
    else delete next[guestId];
    return next;
  });

  const remove = (guestId: string) => update((store) => {
    if (!store[guestId]) return store;
    const { [guestId]: _removed, ...rest } = store;
    return rest;
  });

  const forDirectory = async (directory: string | null, guestIds: Set<string>) => {
    if (guestIds.size === 0) return [];
    const store = await read();
    const resolved = directory ? path.resolve(directory) : null;
    const result = [];
    for (const guestId of [...guestIds].sort()) {
      const value = store[guestId];
      if (!isJsonContainer(value)) continue;
      const entries = copyEntries(value);
      const keys = Object.keys(entries)
        .filter((key) => key === GLOBAL_KEY || (resolved !== null && isInside(resolved, key)))
        .sort((a, b) => (a === GLOBAL_KEY ? -1 : b === GLOBAL_KEY ? 1 : a.length - b.length));
      const text = keys.map((key) => entries[key]).filter((value) => isString(value) && value).join('\n\n');
      if (text) result.push({ guestId, text });
    }
    return result;
  };

  return { set, remove, forDirectory };
};
