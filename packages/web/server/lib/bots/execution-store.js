import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const json = z.json();
const entrySchema = z.object({ version: z.literal(1), operations: z.record(z.string(), json), data: z.record(z.string(), json) }).strict();
const empty = () => ({ version: 1, operations: {}, data: {} });

/** Private recovery inputs. No credential values belong in this journal. */
export const createBotExecutionStore = ({ store }) => {
  const fileFor = (projectId, itemId) => path.join(path.dirname(store.filePathFor(projectId)), 'bot-executions', `${createHash('sha256').update(itemId).digest('hex')}.json`);
  const readFile = async (file) => {
    try { return entrySchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  };
  const read = (projectId, itemId) => withSourceControlFileLock(`${fileFor(projectId, itemId)}.lock`, () => readFile(fileFor(projectId, itemId)));
  const update = (projectId, itemId, change) => withSourceControlFileLock(`${fileFor(projectId, itemId)}.lock`, async () => {
    const file = fileFor(projectId, itemId);
    const previous = await readFile(file);
    const next = entrySchema.parse(await change(structuredClone(previous)));
    for (const [key, value] of Object.entries(previous.operations)) {
      if (JSON.stringify(next.operations[key]) !== JSON.stringify(value)) throw new Error('Bot effect request is immutable');
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return next;
  });
  return { read, update };
};
