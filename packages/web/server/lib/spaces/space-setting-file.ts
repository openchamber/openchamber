
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { z } from 'zod';

const MAX_SETTING_BYTES = 1024;

export const readSpaceSettingFile = async <T>(filePath: string, schema: z.ZodType<T>) => {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_SETTING_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
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
