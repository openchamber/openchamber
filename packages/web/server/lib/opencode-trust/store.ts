import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { writeFileAtomic } from '../opencode/atomic-write.js';
import type { TrustFileSystem } from './contracts.js';

const FINGERPRINTS_PER_REPOSITORY = 20;

const documentSchema = z.object({
  version: z.literal(1),
  seeded: z.boolean().optional(),
  repositories: z.record(z.string(), z.object({ fingerprints: z.array(z.string().min(1)) })),
});

type TrustDocument = z.infer<typeof documentSchema>;
const emptyDocument = (): TrustDocument => ({ version: 1, repositories: {} });

const parseDocument = (text: string) => documentSchema.parse(JSON.parse(text));

const hasCode = (value: unknown): value is { code: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'code' in value;
export const hasMessage = (value: unknown): value is { message: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'message' in value;

export const createOpenCodeTrustStore = ({ filePath, fsPromises = fs.promises }: { filePath: string; fsPromises?: TrustFileSystem }) => {
  let writes = Promise.resolve();

  const read = async () => {
    let text;
    try {
      text = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (!hasCode(error) || error.code !== 'ENOENT') console.warn(`[opencode-trust] Failed to read ${filePath}:`, hasMessage(error) ? error.message ?? error : error);
      return emptyDocument();
    }
    try {
      return parseDocument(text);
    } catch (error) {
      console.warn(`[opencode-trust] Ignoring unreadable ${filePath}:`, hasMessage(error) ? error.message ?? error : error);
      return emptyDocument();
    }
  };

  const has = async (repositoryKey: string, fingerprint: string) => {
    const document = await read();
    return document.repositories[repositoryKey]?.fingerprints.includes(fingerprint) ?? false;
  };

  const addTo = (document: TrustDocument, repositoryKey: string, fingerprint: string) => {
    const previous = document.repositories[repositoryKey]?.fingerprints ?? [];
    document.repositories[repositoryKey] = {
      fingerprints: [fingerprint, ...previous.filter((value) => value !== fingerprint)].slice(0, FINGERPRINTS_PER_REPOSITORY),
    };
  };

  const update = (change: (document: TrustDocument) => void | false) => {
    const write = writes.then(async () => {
      const document = await read();
      if (change(document) === false) return;
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
    });
    writes = write.catch(() => {});
    return write;
  };

  const add = (repositoryKey: string, fingerprint: string) => update((document) => addTo(document, repositoryKey, fingerprint));

  const isSeeded = async () => (await read()).seeded === true;

  const seed = (entries: [string, string][]) => update((document) => {
    if (document.seeded) return false;
    for (const [repositoryKey, fingerprint] of entries) addTo(document, repositoryKey, fingerprint);
    document.seeded = true;
  });

  return { has, add, isSeeded, seed };
};
