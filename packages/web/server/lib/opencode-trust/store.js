import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { writeFileAtomic } from '../opencode/atomic-write.js';

// The fingerprints the user trusted, per repository. A repository keeps the
// latest few, so switching between branches that each carry their own
// trusted plugins does not ask again.
const FINGERPRINTS_PER_REPOSITORY = 20;

const documentSchema = z.object({
  version: z.literal(1),
  // Set once the projects the user had before this check existed were
  // trusted as they were (`seedKnown`).
  seeded: z.boolean().optional(),
  repositories: z.record(z.string(), z.object({ fingerprints: z.array(z.string().min(1)) })),
});

const emptyDocument = () => ({ version: 1, repositories: {} });

const parseDocument = (text) => documentSchema.parse(JSON.parse(text));

/**
 * Trust answers on disk. A missing file means nothing is trusted yet. A file
 * that cannot be read or parsed also trusts nothing, so the prompt returns
 * rather than code running unasked; the next answer rewrites it.
 */
export const createOpenCodeTrustStore = ({ filePath, fsPromises = fs.promises }) => {
  let writes = Promise.resolve();

  const read = async () => {
    let text;
    try {
      text = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[opencode-trust] Failed to read ${filePath}:`, error?.message ?? error);
      return emptyDocument();
    }
    try {
      return parseDocument(text);
    } catch (error) {
      console.warn(`[opencode-trust] Ignoring unreadable ${filePath}:`, error?.message ?? error);
      return emptyDocument();
    }
  };

  const has = async (repositoryKey, fingerprint) => {
    const document = await read();
    return document.repositories[repositoryKey]?.fingerprints.includes(fingerprint) ?? false;
  };

  const addTo = (document, repositoryKey, fingerprint) => {
    const previous = document.repositories[repositoryKey]?.fingerprints ?? [];
    document.repositories[repositoryKey] = {
      fingerprints: [fingerprint, ...previous.filter((value) => value !== fingerprint)].slice(0, FINGERPRINTS_PER_REPOSITORY),
    };
  };

  // Read, change and write one document at a time, so answers given together
  // all land.
  const update = (change) => {
    const write = writes.then(async () => {
      const document = await read();
      if (change(document) === false) return;
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
    });
    writes = write.catch(() => {});
    return write;
  };

  const add = (repositoryKey, fingerprint) => update((document) => addTo(document, repositoryKey, fingerprint));

  const isSeeded = async () => (await read()).seeded === true;

  /** Trust `entries` (`[repositoryKey, fingerprint]`) and mark the store seeded; a seeded store stays as it is. */
  const seed = (entries) => update((document) => {
    if (document.seeded) return false;
    for (const [repositoryKey, fingerprint] of entries) addTo(document, repositoryKey, fingerprint);
    document.seeded = true;
  });

  return { has, add, isSeeded, seed };
};
