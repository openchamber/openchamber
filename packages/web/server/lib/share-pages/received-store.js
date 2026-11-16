import { z } from 'zod';

const DIRECTORY_NAME = 'received-pages';
const FILE_VERSION = 1;
const RECEIVED_ID_PATTERN = /^rp_[0-9a-f]{32}$/;
// Pages beyond this many are removed, the least recently touched first, with
// their document (up to ~32 MB each); the one just saved always stays.
const MAX_RECEIVED = 100;

const RECEIVED_STATUSES = ['open', 'locked', 'answered', 'expired', 'cancelled', 'missing'];

const sourceSchema = z.object({
  format: z.enum(['ui', 'html']),
  text: z.string(),
  summary: z.string().nullable(),
});

const receivedSchema = z.object({
  version: z.literal(FILE_VERSION),
  id: z.string().regex(RECEIVED_ID_PATTERN),
  // HTTP base of the relay the link names, checked against the allowlist on every use.
  base: z.string().min(1),
  shareId: z.string().min(1),
  host: z.string().min(1),
  // The link's key, and once the PIN was right the two values derived from
  // both. Never logged, never in a response; the PIN itself is not kept.
  linkKey: z.string().min(1),
  secrets: z.object({ auth: z.string().min(1), enc: z.string().min(1) }).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(RECEIVED_STATUSES),
  kind: z.string().nullable(),
  wantsAnswer: z.boolean(),
  expiresAt: z.number().nullable(),
  attemptsLeft: z.number().nullable(),
  title: z.string().nullable(),
  source: sourceSchema.nullable(),
  answer: z.object({ summary: z.string(), data: z.unknown(), submittedAt: z.number() }).nullable(),
});

/** One record per link: the id is a hash of the relay and the share, so pasting a link again finds it. */
export const receivedPageId = (crypto, base, shareId) => (
  `rp_${crypto.createHash('sha256').update(`${base}\u0000${shareId}`).digest('hex').slice(0, 32)}`
);

/**
 * Pages other people shared that this user opened, under
 * `<dataDir>/received-pages/`: `<id>.json` for the record and `<id>.html` for
 * the decrypted document. Owner-readable only, written atomically through one
 * chain. A file that does not parse is moved aside and the rest load.
 */
export const createReceivedPageStore = ({ fsPromises, path, dataDir, now = Date.now }) => {
  const directory = path.join(dataDir, DIRECTORY_NAME);
  const records = new Map();
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const jsonFile = (id) => path.join(directory, `${id}.json`);
  const htmlFile = (id) => path.join(directory, `${id}.html`);

  const readAll = async () => {
    let names;
    try {
      names = await fsPromises.readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(directory, name);
      const parsed = receivedSchema.safeParse(await fsPromises.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null));
      if (parsed.success) {
        records.set(parsed.data.id, parsed.data);
      } else {
        const aside = `${filePath}.corrupt-${now()}`;
        await fsPromises.rename(filePath, aside).catch(() => undefined);
        console.warn(`[received-pages] record ${name} was unreadable and moved to ${aside}`);
      }
    }
  };

  const load = () => {
    loadPromise ??= readAll().catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  };

  const writeAtomic = async (target, content) => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(temporary, target);
  };

  const enqueue = (task) => {
    const run = writeChain.then(task);
    writeChain = run.catch(() => undefined);
    return run;
  };

  const prune = async (savedId) => {
    const oldest = [...records.values()]
      .filter((record) => record.id !== savedId)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const record of oldest.slice(0, Math.max(0, records.size - MAX_RECEIVED))) {
      records.delete(record.id);
      await fsPromises.rm(jsonFile(record.id), { force: true });
      await fsPromises.rm(htmlFile(record.id), { force: true });
    }
  };

  /** Saves a snapshot taken now; the working object is published only once it is on disk. */
  const save = async (record) => {
    const snapshot = JSON.stringify(receivedSchema.parse(record));
    await load();
    return enqueue(async () => {
      await writeAtomic(jsonFile(record.id), snapshot);
      records.set(record.id, record);
      await prune(record.id).catch((error) => {
        console.warn('[received-pages] failed to prune records:', error?.message ?? error);
      });
    });
  };

  const saveDocument = async (id, html) => {
    await load();
    return enqueue(() => writeAtomic(htmlFile(id), html));
  };

  const readDocument = async (id) => {
    try {
      return await fsPromises.readFile(htmlFile(id), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const get = async (id) => {
    await load();
    return records.get(id) ?? null;
  };

  const list = async () => {
    await load();
    return [...records.values()];
  };

  return { load, save, saveDocument, readDocument, get, list };
};
