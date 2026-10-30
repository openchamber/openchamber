import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * The accounts behind extension notification channels (`provides:
 * ["notifications"]`): one account per channel, keyed by the channel's
 * provider id (`ext-<guestId>`), in `{dataDir}/notification-channels.json`,
 * written `0o600` through a temp file and a rename. The token is read by the
 * delivery module alone, to mint a per-call handle; `publicView` is what a
 * route or a card may see and never carries it.
 *
 * A corrupt file is an error, not an empty store: a channel must not read as
 * disconnected because its file could not be parsed. Writes to one file are
 * chained in this process, as the guest auth store's are.
 */

export const notificationChannelsPersistPath = (dataDir) => path.join(dataDir, 'notification-channels.json');

const text = (max) => z.string().min(1).max(max);

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

const emptyStore = () => ({ version: 1, channels: {} });

const corrupt = (persistPath, cause) => Object.assign(new Error(`Notification channel accounts could not be read: ${persistPath}`), {
  code: 'INVALID_NOTIFICATION_CHANNELS_STORE', cause,
});

/** What leaves this module: the instance and who the account is, never the token. */
const publicViewOf = (channel) => {
  if (!channel) return null;
  const account = {
    id: channel.account.id,
    login: channel.account.login,
    connectedAt: channel.account.connectedAt,
    status: channel.account.status,
  };
  if (channel.account.name) account.name = channel.account.name;
  if (channel.account.invalidReason) account.invalidReason = channel.account.invalidReason;
  return { instance: channel.instance, account };
};

/**
 * @param {{ persistPath: string, now?: () => number, fsImpl?: typeof fs }} options
 */
export const createNotificationChannelAccounts = ({ persistPath, now = Date.now, fsImpl = fs }) => {
  let chain = Promise.resolve();
  let writeSequence = 0;
  const pendingConnections = new Map();

  const beginConnect = (providerId) => {
    const revision = Symbol();
    pendingConnections.set(providerId, revision);
    return revision;
  };

  const readStore = async () => {
    let raw;
    try {
      raw = await fsImpl.readFile(persistPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyStore();
      throw corrupt(persistPath, error);
    }
    if (raw.trim().length === 0) return emptyStore();
    let parsed;
    try {
      parsed = storeSchema.safeParse(JSON.parse(raw));
    } catch (error) {
      throw corrupt(persistPath, error);
    }
    if (!parsed.success) throw corrupt(persistPath, parsed.error);
    return parsed.data;
  };

  const writeStore = async (store) => {
    const parsed = storeSchema.safeParse(store);
    if (!parsed.success) throw new Error('Invalid notification channel accounts store');
    await fsImpl.mkdir(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp-${process.pid}-${now()}-${(writeSequence += 1)}`;
    await fsImpl.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(tmp, persistPath);
    await fsImpl.chmod(persistPath, 0o600);
  };

  /** Read-modify-write under this process's chain for the file. */
  const mutate = (change) => {
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
    cancelConnect: (providerId) => pendingConnections.delete(providerId),
    /** The stored channel with its token, for minting a handle; null when none is connected. */
    read: async (providerId) => (await readStore()).channels[providerId] ?? null,
    publicView: async (providerId) => publicViewOf((await readStore()).channels[providerId] ?? null),
    /** Every connected channel's public view, by provider id. */
    list: async () => Object.fromEntries(Object.entries((await readStore()).channels).map(([id, channel]) => [id, publicViewOf(channel)])),
    /** Connecting replaces whatever account the channel had: one account per channel. */
    set: (providerId, { instance, token, account }, expectedConnection) => mutate((store) => {
      if (expectedConnection !== undefined && pendingConnections.get(providerId) !== expectedConnection) return null;
      pendingConnections.delete(providerId);
      const stored = { id: account.id, login: account.login ?? null, token, connectedAt: now(), status: 'valid' };
      if (account.name) stored.name = account.name;
      store.channels[providerId] = { revision: randomUUID(), instance, account: stored };
      return publicViewOf(store.channels[providerId]);
    }),
    /** The channel's server refused the token: the account stays, marked, until the user reconnects. */
    markInvalid: (providerId, reason = 'unauthorized', expectedChannel) => mutate((store) => {
      const channel = store.channels[providerId];
      if (!channel) return false;
      if (expectedChannel && JSON.stringify(channel) !== JSON.stringify(expectedChannel)) return false;
      channel.account.status = 'invalid';
      channel.account.invalidReason = reason;
      return true;
    }),
    /** Disconnect, and "remove means forget" for an uninstalled extension. */
    remove: (providerId) => {
      pendingConnections.delete(providerId);
      return mutate((store) => {
        const had = Boolean(store.channels[providerId]);
        delete store.channels[providerId];
        return had;
      });
    },
  });
};
