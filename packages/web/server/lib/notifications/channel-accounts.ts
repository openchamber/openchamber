import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { isMissingFile } from './inputs.js';


export const notificationChannelsPersistPath = (dataDir: string) => path.join(dataDir, 'notification-channels.json');

const text = (max: number) => z.string().min(1).max(max);

const accountSchema = z.object({
  id: text(256),
  login: text(256).nullable(),
  name: text(256).optional(),
  token: text(4_096),
  connectedAt: z.number().int().nonnegative(),
  status: z.enum(['valid', 'invalid']),
  invalidReason: text(256).optional(),
}).strict();

const channelSchema = z.object({
  revision: z.string().uuid().optional(),
  instance: text(2_048),
  account: accountSchema,
}).strict();

const storeSchema = z.object({
  version: z.literal(1),
  channels: z.record(z.string().min(1).max(64), channelSchema),
}).strict();

export type NotificationChannelAccount = z.infer<typeof accountSchema>;
export type StoredNotificationChannel = z.infer<typeof channelSchema>;
type NotificationChannelStore = z.infer<typeof storeSchema>;
export interface PublicNotificationChannel {
  instance: string;
  account: Omit<NotificationChannelAccount, 'token'>;
}

const emptyStore = (): NotificationChannelStore => ({ version: 1, channels: {} });

const corrupt = (persistPath: string, failure: { cause: unknown }) => Object.assign(new Error(`Notification channel accounts could not be read: ${persistPath}`), {
  code: 'INVALID_NOTIFICATION_CHANNELS_STORE', cause: failure.cause,
});

const publicViewOf = (channel: StoredNotificationChannel | null | undefined): PublicNotificationChannel | null => {
  if (!channel) return null;
  const account: PublicNotificationChannel['account'] = {
    id: channel.account.id,
    login: channel.account.login,
    connectedAt: channel.account.connectedAt,
    status: channel.account.status,
  };
  if (channel.account.name) account.name = channel.account.name;
  if (channel.account.invalidReason) account.invalidReason = channel.account.invalidReason;
  return { instance: channel.instance, account };
};

export const createNotificationChannelAccounts = ({ persistPath, now = Date.now, fsImpl = fs }: {
  persistPath: string;
  now?: () => number;
  fsImpl?: typeof fs;
}) => {
  let chain: Promise<unknown> = Promise.resolve();
  let writeSequence = 0;
  const pendingConnections = new Map<string, symbol>();

  const beginConnect = (providerId: string) => {
    const revision = Symbol();
    pendingConnections.set(providerId, revision);
    return revision;
  };

  const readStore = async () => {
    let raw;
    try {
      raw = await fsImpl.readFile(persistPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return emptyStore();
      throw corrupt(persistPath, { cause: error });
    }
    if (raw.trim().length === 0) return emptyStore();
    let parsed;
    try {
      parsed = storeSchema.safeParse(JSON.parse(raw));
    } catch (error) {
      throw corrupt(persistPath, { cause: error });
    }
    if (!parsed.success) throw corrupt(persistPath, { cause: parsed.error });
    return parsed.data;
  };

  const writeStore = async (store: NotificationChannelStore) => {
    const parsed = storeSchema.safeParse(store);
    if (!parsed.success) throw new Error('Invalid notification channel accounts store');
    await fsImpl.mkdir(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp-${process.pid}-${now()}-${(writeSequence += 1)}`;
    await fsImpl.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(tmp, persistPath);
    await fsImpl.chmod(persistPath, 0o600);
  };

  const mutate = <T>(change: (store: NotificationChannelStore) => T) => {
    const next = chain.catch(() => undefined).then(async () => {
      const store = await readStore();
      const result = change(store);
      await writeStore(store);
      return result;
    });
    chain = next;
    return next;
  };

  return Object.freeze({
    beginConnect,
    cancelConnect: (providerId: string) => pendingConnections.delete(providerId),
    read: async (providerId: string) => (await readStore()).channels[providerId] ?? null,
    publicView: async (providerId: string) => publicViewOf((await readStore()).channels[providerId] ?? null),
    list: async () => Object.fromEntries(Object.entries((await readStore()).channels).map(([id, channel]) => [id, publicViewOf(channel)])),
    set: (providerId: string, { instance, token, account }: {
      instance: string;
      token: string;
      account: Pick<NotificationChannelAccount, 'id' | 'login' | 'name'>;
    }, expectedConnection?: symbol) => mutate((store) => {
      if (expectedConnection !== undefined && pendingConnections.get(providerId) !== expectedConnection) return null;
      pendingConnections.delete(providerId);
      const stored: NotificationChannelAccount = { id: account.id, login: account.login ?? null, token, connectedAt: now(), status: 'valid' };
      if (account.name) stored.name = account.name;
      store.channels[providerId] = { revision: randomUUID(), instance, account: stored };
      return publicViewOf(store.channels[providerId]);
    }),
    markInvalid: (providerId: string, reason = 'unauthorized', expectedChannel?: StoredNotificationChannel) => mutate((store) => {
      const channel = store.channels[providerId];
      if (!channel) return false;
      if (expectedChannel && JSON.stringify(channel) !== JSON.stringify(expectedChannel)) return false;
      channel.account.status = 'invalid';
      channel.account.invalidReason = reason;
      return true;
    }),
    remove: (providerId: string) => {
      pendingConnections.delete(providerId);
      return mutate((store) => {
        const had = Boolean(store.channels[providerId]);
        delete store.channels[providerId];
        return had;
      });
    },
  });
};
