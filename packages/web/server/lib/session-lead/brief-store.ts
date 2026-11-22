import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const BRIEF_MAX_LENGTH = 12_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const missingFileSchema = z.object({ code: z.literal('ENOENT') });

export const createLeadBriefStore = ({ dataDir }: { dataDir: string }) => {
  const directory = path.join(dataDir, 'leads');

  const fileOf = (sessionId: string, suffix: string) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Not a session id: ${sessionId}`);
    return path.join(directory, `${sessionId}${suffix}`);
  };

  const readFile = async (file: string) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (missingFileSchema.safeParse(error).success) return null;
      throw error;
    }
  };

  const writeFile = async (file: string, body: string) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const pathOf = (sessionId: string) => fileOf(sessionId, '.md');
  const read = (sessionId: string) => readFile(pathOf(sessionId));
  const write = (sessionId: string, body: string) => writeFile(fileOf(sessionId, '.md'), body);

  const readDelivered = (sessionId: string) => readFile(fileOf(sessionId, '.entry.md'));
  const writeDelivered = (sessionId: string, body: string) => writeFile(fileOf(sessionId, '.entry.md'), body);
  const forgetDelivered = async (sessionId: string) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    await fs.rm(fileOf(sessionId, '.entry.md'), { force: true });
  };

  const remove = async (sessionId: string) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    await Promise.all([fs.rm(fileOf(sessionId, '.md'), { force: true }), forgetDelivered(sessionId)]);
  };

  return { pathOf, read, write, readDelivered, writeDelivered, forgetDelivered, remove };
};

export type LeadBriefStore = ReturnType<typeof createLeadBriefStore>;
