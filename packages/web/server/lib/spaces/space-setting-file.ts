import fs from 'node:fs';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import path from 'node:path';
import crypto from 'node:crypto';
import type { z } from 'zod';

const MAX_SETTING_BYTES = 1024;

/**
 * The file parsed with `schema`, or null when it is missing, not a plain file of at most 1 KiB,
 * not JSON, or not what the schema takes. The caller decides what null means, and it must be the
 * cautious answer: whatever the agent wrote there gives it nothing the user did not choose.
 *
 * The read goes through the shared bounded reader with noFollow (#1659):
 * regularity and size are judged from the opened handle and the cap is
 * enforced in flight, so a file swapped or grown between a by-path lstat and
 * a by-path read can no longer defeat either half of the gate (the race this
 * replaces), and a symlink is judged at open (ELOOP) rather than followed or
 * pre-screened by path. Every non-ok outcome — missing, non-regular
 * (including a FIFO), over-cap, symlink — and every thrown error answers
 * null, exactly as the lstat gate answered for the file it saw.
 */
export const readSpaceSettingFile = async <T>(filePath: string, schema: z.ZodType<T>) => {
  try {
    const result = await readBoundedFile(filePath, MAX_SETTING_BYTES, { noFollow: true });
    if (!result.ok) return null;
    const parsed = schema.safeParse(JSON.parse(result.buffer.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const writeSpaceSettingFile = async <T>(filePath: string, value: T, schema: z.ZodType<T>) => {
  const text = `${JSON.stringify(schema.parse(value))}\n`;
  if (Buffer.byteLength(text) > MAX_SETTING_BYTES) throw new Error('Space setting exceeds 1 KiB');
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};
