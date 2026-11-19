import { z } from 'zod';
import { isMissingFileError } from './file-errors.js';
import type { ShareStoreOptions } from './contracts.js';

const DIRECTORY_NAME = 'share-pages';
const FILE_VERSION = 1;
const GROUP_ID_PATTERN = /^sp_[0-9a-f]{32}$/;
const MAX_GROUPS = 100;
const FINAL_STATUSES = new Set(['answered', 'expired', 'cancelled', 'failed']);

const isFinished = (group: ShareGroup) => group.recipients.every((recipient) => (
  FINAL_STATUSES.has(recipient.status) && (recipient.delivery === null || recipient.delivery.delivered)
));

const recipientSchema = z.object({
  recipientId: z.string().min(1),
  label: z.string().min(1),
  pin: z.string().regex(/^\d{6}$/),
  linkKey: z.string().min(1),
  shareId: z.string().nullable(),
  url: z.string().nullable(),
  status: z.enum(['preparing', 'open', 'locked', 'answered', 'expired', 'cancelled', 'failed']),
  opens: z.array(z.number()),
  answeredAt: z.number().nullable(),
  answer: z.object({ summary: z.string(), data: z.unknown(), submittedAt: z.number().nullable() }).nullable(),
  delivery: z.object({ messageId: z.string(), delivered: z.boolean() }).nullable(),
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
  relayBase: z.string().min(1),
  documentState: z.enum(['preparing', 'ready']),
  documentSource: z.object({ format: z.enum(['ui', 'html']), text: z.string(), summary: z.string().nullable() }).nullable().optional(),
  recipients: z.array(recipientSchema).min(1),
});

export type ShareGroup = z.infer<typeof groupSchema>;

export const shareGroupId = (crypto: typeof import('node:crypto'), sessionId: string, callId: string) => (
  `sp_${crypto.createHash('sha256').update(`${sessionId}\u0000${callId}`).digest('hex').slice(0, 32)}`
);

export const createSharePageStore = ({ fsPromises, path, dataDir, now = Date.now }: ShareStoreOptions) => {
  const directory = path.join(dataDir, DIRECTORY_NAME);
  const groups = new Map<string, ShareGroup>();
  let loadPromise: Promise<void> | null = null;
  let writeChain = Promise.resolve();

  const jsonFile = (id: string) => path.join(directory, `${id}.json`);
  const htmlFile = (id: string) => path.join(directory, `${id}.html`);

  const readAll = async () => {
    let names;
    try {
      names = await fsPromises.readdir(directory);
    } catch (error) {
      if (isMissingFileError(error)) return;
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

  const writeAtomic = async (target: string, content: string) => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(temporary, target);
  };

  const enqueue = (task: () => Promise<void>) => {
    const run = writeChain.then(task);
    writeChain = run.catch(() => undefined);
    return run;
  };

  const prune = async (savedId: string) => {
    const finished = [...groups.values()]
      .filter((group) => group.id !== savedId && isFinished(group))
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const group of finished.slice(0, Math.max(0, groups.size - MAX_GROUPS))) {
      groups.delete(group.id);
      await fsPromises.rm(jsonFile(group.id), { force: true });
      await fsPromises.rm(htmlFile(group.id), { force: true });
    }
  };

  const save = async (group: ShareGroup) => {
    const snapshot = JSON.stringify(groupSchema.parse(group));
    await load();
    return enqueue(async () => {
      await writeAtomic(jsonFile(group.id), snapshot);
      groups.set(group.id, group);
      await prune(group.id).catch((error) => {
        console.warn('[share-pages] failed to prune groups:', error?.message ?? error);
      });
    });
  };

  const saveDocument = async (id: string, html: string) => {
    await load();
    return enqueue(() => writeAtomic(htmlFile(id), html));
  };

  const readDocument = async (id: string) => {
    try {
      return await fsPromises.readFile(htmlFile(id), 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  };

  const get = async (id: string) => {
    await load();
    return groups.get(id) ?? null;
  };

  const list = async () => {
    await load();
    return [...groups.values()];
  };

  return { load, save, saveDocument, readDocument, get, list };
};
