import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

/** Private adapter records. File locks protect commits; owner locks protect effects. */
export function createBotAdapterState({ dataDir, name, schema }) {
  const directory = path.join(dataDir, 'bots', name);
  const fileFor = (key) => path.join(directory, `${digestMutationInput(key)}.json`);
  const load = async (file) => {
    try { return schema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const read = (key) => withSourceControlFileLock(`${fileFor(key)}.lock`, () => load(fileFor(key)));
  const write = (key, value) => withSourceControlFileLock(`${fileFor(key)}.lock`, async () => {
    const parsed = schema.parse(value);
    const file = fileFor(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return parsed;
  });
  const list = async () => {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
      const file = path.join(directory, name);
      const entry = await withSourceControlFileLock(`${file}.lock`, () => load(file));
      if (entry) entries.push(entry);
    }
    return entries;
  };
  return { read, write, list, own: (key, operation) => withSourceControlFileLock(`${fileFor(key)}.owner.lock`, operation, { waitMs: 10_000 }) };
}
