import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { TrackerRouteError } from './route-error.js';
import type { TrackerOAuthTarget } from './extension-oauth.js';


export const trackerAccountsPersistPath = (dataDir: string) => path.join(dataDir, 'tracker-accounts.json');

export const TRACKER_SESSION_RECORDS_MAX = 500;
export const TRACKER_ACCOUNTS_MAX = 32;

const text = (max: number) => z.string().min(1).max(max);

const oauthTargetSchema = z.object({ authorizeUrl: text(2_048), tokenUrl: text(2_048) }).strict();

const credentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), token: text(4_096), login: text(256).nullable() }).strict(),
  z.object({
    kind: z.literal('oauth'),
    accessToken: text(8_192),
    refreshToken: text(8_192).nullable(),
    expiresAt: z.number().int().positive().nullable(),
    target: oauthTargetSchema,
  }).strict(),
]);

const accountSchema = z.object({
  id: text(256),
  login: text(256).nullable(),
  name: text(256).optional(),
  avatarUrl: z.string().max(2_048).optional(),
  revision: z.string().uuid(),
  connectedAt: z.number().int().nonnegative(),
  status: z.enum(['valid', 'invalid']),
  invalidReason: text(256).optional(),
  credential: credentialSchema,
}).strict();

const clientSchema = z.object({
  id: text(512),
  secret: text(4_096).optional(),
  target: oauthTargetSchema,
}).strict();

const sessionRecordSchema = z.object({
  identifier: text(128),
  sessionOrigin: text(2_048).nullable(),
  started: z.boolean(),
  completed: z.boolean(),
  failure: z.boolean(),
}).strict();

const trackerSchema = z.object({
  instance: text(2_048).nullable(),
  client: clientSchema.optional(),
  accounts: z.array(accountSchema).max(TRACKER_ACCOUNTS_MAX),
  activeAccountId: text(256).nullable(),
  mapping: z.object({
    defaultProjectPath: text(4_096).nullable(),
    containerProjectPaths: z.record(text(256), text(4_096)),
  }).strict().optional(),
  preferences: z.object({ sessionComments: z.boolean() }).strict().optional(),
  sessions: z.record(text(256), sessionRecordSchema).optional(),
}).strict();

const storeSchema = z.object({
  version: z.literal(1),
  trackers: z.record(z.string().min(1).max(64), trackerSchema),
}).strict();

export type TrackerCredential = z.infer<typeof credentialSchema>;
export type StoredTrackerAccount = z.infer<typeof accountSchema>;
export type StoredTracker = z.infer<typeof trackerSchema>;
type AccountStore = z.infer<typeof storeSchema>;
type StoredClient = z.infer<typeof clientSchema>;
type SessionRecord = z.infer<typeof sessionRecordSchema>;
type PublicAccount = Omit<StoredTrackerAccount, 'credential' | 'revision' | 'name' | 'avatarUrl' | 'invalidReason'> & {
  method: TrackerCredential['kind'];
  name?: string;
  avatarUrl?: string;
  invalidReason?: string;
};
type ConnectAccount = Pick<StoredTrackerAccount, 'id' | 'login' | 'name' | 'avatarUrl'>;

const emptyStore = (): AccountStore => ({ version: 1, trackers: {} });
const emptyTracker = (): StoredTracker => ({ instance: null, accounts: [], activeAccountId: null });

const corrupt = (persistPath: string, cause: unknown) => Object.assign(new Error(`Tracker accounts could not be read: ${persistPath}`), {
  code: 'INVALID_TRACKER_ACCOUNTS_STORE', cause,
});

const conflict = (code: string, message: string) => new TrackerRouteError(409, code, message);

const publicAccountOf = (account: StoredTrackerAccount) => {
  const view: PublicAccount = {
    id: account.id,
    login: account.login,
    connectedAt: account.connectedAt,
    status: account.status,
    method: account.credential.kind,
  };
  if (account.name) view.name = account.name;
  if (account.avatarUrl) view.avatarUrl = account.avatarUrl;
  if (account.invalidReason) view.invalidReason = account.invalidReason;
  return view;
};

const publicViewOf = (tracker: StoredTracker | null) => {
  if (!tracker) return { instance: null, accounts: [], activeAccountId: null, hasClient: false };
  return {
    instance: tracker.instance,
    accounts: tracker.accounts.map(publicAccountOf),
    activeAccountId: tracker.activeAccountId,
    hasClient: Boolean(tracker.client),
  };
};

const sameTarget = (a: TrackerOAuthTarget, b: TrackerOAuthTarget) => Boolean(a && b) && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl;

const clearIfEmpty = (tracker: StoredTracker) => {
  if (tracker.accounts.length > 0) return;
  tracker.instance = null;
  tracker.activeAccountId = null;
  delete tracker.client;
  delete tracker.mapping;
};

const isMissingFile = (value: unknown): value is { code: 'ENOENT' } => value !== null
  && typeof value === 'object' && 'code' in value && value.code === 'ENOENT';

export const createTrackerAccounts = ({ persistPath, now = Date.now, fsImpl = fs }: { persistPath: string; now?: () => number; fsImpl?: typeof fs }) => {
  let chain: Promise<unknown> = Promise.resolve();
  let writeSequence = 0;
  const pendingConnections = new Map<string, symbol>();

  const readStore = async () => {
    let raw;
    try {
      raw = await fsImpl.readFile(persistPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return emptyStore();
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

  const writeStore = async (store: AccountStore) => {
    const parsed = storeSchema.safeParse(store);
    if (!parsed.success) throw new Error('Invalid tracker accounts store');
    await fsImpl.mkdir(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp-${process.pid}-${now()}-${(writeSequence += 1)}`;
    await fsImpl.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(tmp, persistPath);
    await fsImpl.chmod(persistPath, 0o600);
  };

  const mutate = <T>(change: (store: AccountStore) => { wrote?: boolean; result: T }) => {
    const next = chain.catch(() => undefined).then(async () => {
      const store = await readStore();
      const outcome = change(store);
      if (outcome?.wrote !== false) await writeStore(store);
      return outcome?.result;
    });
    chain = next;
    return next;
  };

  const trackerIn = (store: AccountStore, providerId: string) => {
    store.trackers[providerId] ??= emptyTracker();
    return store.trackers[providerId];
  };

  const accountAt = (tracker: StoredTracker | undefined, accountId: string, expectedRevision: string | undefined) => {
    const account = tracker?.accounts.find((candidate) => candidate.id === accountId) ?? null;
    if (!account) return null;
    return expectedRevision === undefined || account.revision === expectedRevision ? account : null;
  };

  return Object.freeze({
    beginConnect: (providerId: string) => {
      const connection: symbol = Symbol('connect');
      pendingConnections.set(providerId, connection);
      return connection;
    },
    cancelConnect: (providerId: string, expected?: symbol) => {
      if (expected !== undefined && pendingConnections.get(providerId) !== expected) return false;
      return pendingConnections.delete(providerId);
    },

    read: async (providerId: string) => (await readStore()).trackers[providerId] ?? null,
    publicView: async (providerId: string) => publicViewOf((await readStore()).trackers[providerId] ?? null),
    list: async () => Object.fromEntries(Object.entries((await readStore()).trackers).map(([id, tracker]) => [id, publicViewOf(tracker)])),

    connect: (providerId: string, { instance, account, credential }: { instance: string; account: ConnectAccount; credential: TrackerCredential }, expectedConnection?: symbol) => mutate((store) => {
      if (expectedConnection !== undefined && pendingConnections.get(providerId) !== expectedConnection) return { wrote: false, result: null };
      pendingConnections.delete(providerId);
      const tracker = trackerIn(store, providerId);
      if (tracker.instance && tracker.instance !== instance && tracker.accounts.length > 0) {
        throw conflict('INSTANCE_MISMATCH', `The connected accounts live on ${tracker.instance}; disconnect them before connecting to ${instance}.`);
      }
      if (tracker.accounts.length >= TRACKER_ACCOUNTS_MAX && !tracker.accounts.some((candidate) => candidate.id === account.id)) {
        throw conflict('ACCOUNTS_FULL', `At most ${TRACKER_ACCOUNTS_MAX} accounts per tracker.`);
      }
      const stored: StoredTrackerAccount = {
        id: account.id,
        login: account.login ?? null,
        revision: randomUUID(),
        connectedAt: now(),
        status: 'valid',
        credential,
      };
      if (account.name) stored.name = account.name;
      if (account.avatarUrl) stored.avatarUrl = account.avatarUrl;
      tracker.instance = instance;
      tracker.accounts = [...tracker.accounts.filter((candidate) => candidate.id !== account.id), stored];
      tracker.activeAccountId = account.id;
      return { result: publicViewOf(tracker) };
    }),

    setClient: (providerId: string, { instance, clientId, clientSecret, target }: { instance: string; clientId: string; clientSecret?: string; target: TrackerOAuthTarget }) => mutate((store) => {
      const tracker = trackerIn(store, providerId);
      if (tracker.instance && tracker.instance !== instance && tracker.accounts.length > 0) {
        throw conflict('INSTANCE_MISMATCH', `The connected accounts live on ${tracker.instance}; disconnect them before connecting to ${instance}.`);
      }
      const previous = tracker.client;
      const client: StoredClient = { id: clientId, target: { ...target } };
      if (clientSecret) client.secret = clientSecret;
      else if (previous?.secret && previous.id === clientId && sameTarget(previous.target, target)) client.secret = previous.secret;
      tracker.instance = instance;
      tracker.client = client;
      return { result: publicViewOf(tracker) };
    }),

    readClient: async (providerId: string, target: TrackerOAuthTarget) => {
      const client = (await readStore()).trackers[providerId]?.client;
      return client && sameTarget(client.target, target) ? { id: client.id, secret: client.secret ?? '' } : null;
    },

    activate: (providerId: string, accountId: string) => mutate((store) => {
      const tracker = store.trackers[providerId];
      const account = tracker?.accounts.find((candidate) => candidate.id === accountId && candidate.status === 'valid');
      if (!account || !tracker) return { wrote: false, result: false };
      tracker.activeAccountId = accountId;
      return { result: true };
    }),

    removeAccount: (providerId: string, accountId: string) => {
      pendingConnections.delete(providerId);
      return mutate((store) => {
        const tracker = store.trackers[providerId];
        if (!tracker?.accounts.some((candidate) => candidate.id === accountId)) return { wrote: false, result: false };
        tracker.accounts = tracker.accounts.filter((candidate) => candidate.id !== accountId);
        if (tracker.activeAccountId === accountId) {
          tracker.activeAccountId = tracker.accounts.find((candidate) => candidate.status === 'valid')?.id ?? null;
        }
        clearIfEmpty(tracker);
        return { result: true };
      });
    },

    markInvalid: (providerId: string, accountId: string, reason: string, expectedRevision?: string) => mutate((store) => {
      const tracker = store.trackers[providerId];
      const account = accountAt(tracker, accountId, expectedRevision);
      if (!account || !tracker) return { wrote: false, result: false };
      account.status = 'invalid';
      account.invalidReason = reason;
      if (tracker.activeAccountId === accountId) {
        tracker.activeAccountId = tracker.accounts.find((candidate) => candidate.status === 'valid')?.id ?? accountId;
      }
      return { result: true };
    }),

    updateCredential: (providerId: string, accountId: string, credential: TrackerCredential, expectedRevision?: string) => mutate((store) => {
      const account = accountAt(store.trackers[providerId], accountId, expectedRevision);
      if (!account) return { wrote: false, result: null };
      account.credential = credential;
      account.revision = randomUUID();
      account.status = 'valid';
      delete account.invalidReason;
      return { result: account.revision };
    }),

    mapping: async (providerId: string) => (await readStore()).trackers[providerId]?.mapping ?? { defaultProjectPath: null, containerProjectPaths: {} },
    setMapping: (providerId: string, { defaultProjectPath, containerProjectPaths }: NonNullable<StoredTracker['mapping']>) => mutate((store) => {
      const tracker = store.trackers[providerId];
      if (!tracker) return { wrote: false, result: null };
      tracker.mapping = { defaultProjectPath: defaultProjectPath ?? null, containerProjectPaths: { ...containerProjectPaths } };
      return { result: tracker.mapping };
    }),

    preferences: async (providerId: string) => (await readStore()).trackers[providerId]?.preferences ?? { sessionComments: false },
    setPreferences: (providerId: string, { sessionComments }: NonNullable<StoredTracker['preferences']>) => mutate((store) => {
      const tracker = store.trackers[providerId];
      if (!tracker) return { wrote: false, result: { sessionComments: false } };
      tracker.preferences = { sessionComments: sessionComments === true };
      return { result: tracker.preferences };
    }),

    sessionRecord: async (providerId: string, sessionId: string) => (await readStore()).trackers[providerId]?.sessions?.[sessionId] ?? null,
    writeSessionRecord: (providerId: string, sessionId: string, record: SessionRecord) => mutate<SessionRecord | false>((store) => {
      const tracker = store.trackers[providerId];
      if (!tracker) return { wrote: false, result: false };
      const previous = tracker.sessions?.[sessionId] ?? null;
      const sessions = { ...(tracker.sessions ?? {}) };
      delete sessions[sessionId];
      sessions[sessionId] = {
        identifier: record.identifier,
        sessionOrigin: record.sessionOrigin,
        started: previous?.started === true || record.started === true,
        completed: previous?.completed === true || record.completed === true,
        failure: previous?.failure === true || record.failure === true,
      };
      const keys = Object.keys(sessions);
      tracker.sessions = keys.length > TRACKER_SESSION_RECORDS_MAX
        ? Object.fromEntries(Object.entries(sessions).slice(keys.length - TRACKER_SESSION_RECORDS_MAX))
        : sessions;
      return { result: record };
    }),

    remove: (providerId: string) => {
      pendingConnections.delete(providerId);
      return mutate((store) => {
        const had = Boolean(store.trackers[providerId]);
        delete store.trackers[providerId];
        return { wrote: had, result: had };
      });
    },
  });
};
