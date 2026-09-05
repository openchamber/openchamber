import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const GUEST_SOURCES = ['path', 'zip', 'git'];

const storeSchema = z.object({
  paths: z.array(z.string().min(1).refine((entry) => !entry.includes('\0'))),
  sources: z.record(z.string(), z.enum(GUEST_SOURCES)).optional(),
  agentGrants: z.record(z.string(), z.literal(true)).optional(),
});

const parseStore = (raw) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const dataDirSchema = z.string().min(1).refine((entry) => !entry.includes('\0') && path.isAbsolute(entry));

/** `{openchamberDataDir}/extensions.json`. One catalog per OpenChamber instance. */
export const extensionsPersistPath = (dataDir) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest persist needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'extensions.json');
};

export const guestCopiesDir = (persistPath) => path.join(path.dirname(persistPath), 'guests');

const realOrResolved = (value) => {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

export const isCopiedGuestRoot = (root, persistPath) => {
  const copies = realOrResolved(guestCopiesDir(persistPath));
  const resolved = realOrResolved(root);
  return resolved === copies || resolved.startsWith(`${copies}${path.sep}`);
};

export const readExtensionStore = async (persistPath) => {
  try {
    const raw = await fs.readFile(persistPath, 'utf8');
    const parsed = parseStore(raw);
    if (!parsed) {
      throw new Error('Invalid extensions store');
    }
    return {
      paths: parsed.paths,
      sources: parsed.sources ?? {},
      agentGrants: parsed.agentGrants ?? {},
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { paths: [], sources: {}, agentGrants: {} };
    }
    throw error;
  }
};

export const writeExtensionStore = async (persistPath, { paths, sources = {}, agentGrants = {} }) => {
  const cleaned = {};
  for (const entry of paths) {
    const source = sources[entry];
    if (source && source !== 'path') {
      cleaned[entry] = source;
    }
  }
  const grants = {};
  for (const [id, granted] of Object.entries(agentGrants)) {
    if (granted) {
      grants[id] = true;
    }
  }
  const payload = { paths };
  if (Object.keys(cleaned).length > 0) {
    payload.sources = cleaned;
  }
  if (Object.keys(grants).length > 0) {
    payload.agentGrants = grants;
  }
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  const tmp = `${persistPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, persistPath);
};

export const readExtensionPaths = async (persistPath) => {
  const store = await readExtensionStore(persistPath);
  return store.paths;
};

export const writeExtensionPaths = async (paths, persistPath) => {
  const current = await readExtensionStore(persistPath);
  const sources = {};
  for (const entry of paths) {
    if (current.sources[entry]) {
      sources[entry] = current.sources[entry];
    }
  }
  await writeExtensionStore(persistPath, {
    paths,
    sources,
    agentGrants: current.agentGrants,
  });
};
