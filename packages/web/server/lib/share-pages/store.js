import { z } from 'zod';

const DIRECTORY_NAME = 'share-pages';
const FILE_VERSION = 1;
const GROUP_ID_PATTERN = /^sp_[0-9a-f]{32}$/;
// Finished groups beyond this many are removed, oldest first, with their
// local page copy (up to ~32 MB each); a group still in play is never removed.
const MAX_GROUPS = 100;
const FINAL_STATUSES = new Set(['answered', 'expired', 'cancelled', 'failed']);

const isFinished = (group) => group.recipients.every((recipient) => (
  FINAL_STATUSES.has(recipient.status) && (recipient.delivery === null || recipient.delivery.delivered)
));

const RECIPIENT_STATUSES = ['preparing', 'open', 'locked', 'answered', 'expired', 'cancelled', 'failed'];

const recipientSchema = z.object({
  recipientId: z.string().min(1),
  label: z.string().min(1),
  // Both secrets stay in this file and the card; never in a log, the tool result or the relay.
  pin: z.string().regex(/^\d{6}$/),
  linkKey: z.string().min(1),
  shareId: z.string().nullable(),
  url: z.string().nullable(),
  status: z.enum(RECIPIENT_STATUSES),
  opens: z.array(z.number()),
  answeredAt: z.number().nullable(),
  answer: z.object({ summary: z.string(), data: z.unknown(), submittedAt: z.number().nullable() }).nullable(),
  // Minted before the first attempt, so a retry never posts the answer twice.
  delivery: z.object({ messageId: z.string(), delivered: z.boolean() }).nullable(),
  // The relay dropped the page and the answer (collected or withdrawn).
  relayClosed: z.boolean(),
  error: z.string().nullable(),
});

const groupSchema = z.object({
  version: z.literal(FILE_VERSION),
  id: z.string().regex(GROUP_ID_PATTERN),
  sessionId: z.string().min(1),
  callId: z.string().min(1),
  title: z.string(),
  kind: z.enum(['questionnaire', 'page']),
  expectAnswer: z.boolean(),
  summary: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  // HTTP origin of the relay the shares live on, fixed at creation.
  relayBase: z.string().min(1),
  documentState: z.enum(['preparing', 'ready']),
  recipients: z.array(recipientSchema).min(1),
});

/** One group per tool call; the id is a hash, so any session or call id makes a safe file name. */
export const shareGroupId = (crypto, sessionId, callId) => (
  `sp_${crypto.createHash('sha256').update(`${sessionId}\u0000${callId}`).digest('hex').slice(0, 32)}`
);

/**
 * Share groups on disk under `<dataDir>/share-pages/`: `<id>.json` for the
 * group and `<id>.html` for the document the recipients got, the author's
 * local preview. Owner-readable only, written atomically through one chain.
 * A file that does not parse is moved aside and the rest load; a failed
 * directory read keeps writes off until a load succeeds.
 */
export const createSharePageStore = ({ fsPromises, path, dataDir, now = Date.now }) => {
  const directory = path.join(dataDir, DIRECTORY_NAME);
  const groups = new Map();
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
      const parsed = groupSchema.safeParse(await fsPromises.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null));
      if (parsed.success) {
        groups.set(parsed.data.id, parsed.data);
      } else {
        const aside = `${filePath}.corrupt-${now()}`;
        await fsPromises.rename(filePath, aside).catch(() => undefined);
        console.warn(`[share-pages] group file ${name} was unreadable and moved to ${aside}`);
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

  // Oldest first; the group just saved stays, so a late answer is never dropped as it lands.
  const prune = async (savedId) => {
    const finished = [...groups.values()]
      .filter((group) => group.id !== savedId && isFinished(group))
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const group of finished.slice(0, Math.max(0, groups.size - MAX_GROUPS))) {
      groups.delete(group.id);
      await fsPromises.rm(jsonFile(group.id), { force: true });
      await fsPromises.rm(htmlFile(group.id), { force: true });
    }
  };

  /** Saves a snapshot taken now; the working object is published only once it is on disk. */
  const save = async (group) => {
    const snapshot = JSON.stringify(groupSchema.parse(group));
    await load();
    return enqueue(async () => {
      await writeAtomic(jsonFile(group.id), snapshot);
      groups.set(group.id, group);
      // Retention cannot turn a committed save into a failed one.
      await prune(group.id).catch((error) => {
        console.warn('[share-pages] failed to prune groups:', error?.message ?? error);
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

  // Mutable working references, not proof of a successful save.
  const get = async (id) => {
    await load();
    return groups.get(id) ?? null;
  };

  const list = async () => {
    await load();
    return [...groups.values()];
  };

  return { load, save, saveDocument, readDocument, get, list };
};
