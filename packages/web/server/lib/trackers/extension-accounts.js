import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * Everything OpenChamber keeps for an extension's tracker (`provides:
 * ["tracker"]`), by its provider id (`ext-<guestId>`), in
 * `{dataDir}/tracker-accounts.json`, written `0o600` through a temp file and a
 * rename: the one instance the accounts live on, the OAuth client the user
 * entered for it, the accounts with their credentials (a pasted token, or the
 * tokens an OAuth sign-in minted), which account is current, the project
 * mapping, the session comment preference and the session status records.
 *
 * Credentials are read by the adapter alone, to mint a per-call handle;
 * `publicView` is what a route or a card may see and never carries one.
 *
 * Every write that follows an await elsewhere is a compare-and-set: a connect
 * commits only under the operation identity `beginConnect` handed out (a
 * Disconnect meanwhile wins), and an invalidation or a token refresh commits
 * only against the account revision it was read at, so a delayed 401 for a
 * replaced token cannot write off its replacement, which may carry the same
 * content and timestamp.
 *
 * A corrupt file is an error, not an empty store: a tracker must not read as
 * disconnected because its file could not be parsed. Writes to one file are
 * chained in this process.
 */

export const trackerAccountsPersistPath = (dataDir) => path.join(dataDir, 'tracker-accounts.json');

/** Session status records kept per tracker; the oldest go first. */
export const TRACKER_SESSION_RECORDS_MAX = 500;
export const TRACKER_ACCOUNTS_MAX = 32;

const text = (max) => z.string().min(1).max(max);

const oauthTargetSchema = z.object({ authorizeUrl: text(2_048), tokenUrl: text(2_048) }).strict();

const credentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), token: text(4_096), login: text(256).nullable() }).strict(),
  z.object({
    kind: z.literal('oauth'),
    accessToken: text(8_192),
    refreshToken: text(8_192).nullable(),
    expiresAt: z.number().int().positive().nullable(),
    // Where the tokens were minted: a package that moves its endpoints gets no
    // refresh with them, and the account is written off instead.
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

const emptyStore = () => ({ version: 1, trackers: {} });
const emptyTracker = () => ({ instance: null, accounts: [], activeAccountId: null });

const corrupt = (persistPath, cause) => Object.assign(new Error(`Tracker accounts could not be read: ${persistPath}`), {
  code: 'INVALID_TRACKER_ACCOUNTS_STORE', cause,
});

const conflict = (code, message) => Object.assign(new Error(message), { status: 409, code });

/** What leaves this module about one account: who it is and how it signed in, never a credential. */
const publicAccountOf = (account) => {
  const view = {
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

/** What leaves this module about one tracker: its instance, its accounts, which is current, whether a client is saved. */
const publicViewOf = (tracker) => {
  if (!tracker) return { instance: null, accounts: [], activeAccountId: null, hasClient: false };
  return {
    instance: tracker.instance,
    accounts: tracker.accounts.map(publicAccountOf),
    activeAccountId: tracker.activeAccountId,
    hasClient: Boolean(tracker.client),
  };
};

const sameTarget = (a, b) => Boolean(a && b) && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl;

/** Removing the last account forgets what belonged to that server: the instance, the client, the mapping. */
const clearIfEmpty = (tracker) => {
  if (tracker.accounts.length > 0) return;
  tracker.instance = null;
  tracker.activeAccountId = null;
  delete tracker.client;
  delete tracker.mapping;
};

/**
 * @param {{ persistPath: string, now?: () => number, fsImpl?: typeof fs }} options
 */
export const createTrackerAccounts = ({ persistPath, now = Date.now, fsImpl = fs }) => {
  let chain = Promise.resolve();
  let writeSequence = 0;
  /** Per provider id: the identity of the connect that may still commit. */
  const pendingConnections = new Map();

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
    if (!parsed.success) throw new Error('Invalid tracker accounts store');
    await fsImpl.mkdir(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp-${process.pid}-${now()}-${(writeSequence += 1)}`;
    await fsImpl.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(tmp, persistPath);
    await fsImpl.chmod(persistPath, 0o600);
  };

  /** Read-modify-write under this process's chain for the file; `change` answers the result and may skip the write with `false` in `wrote`. */
  const mutate = (change) => {
    const next = chain.catch(() => undefined).then(async () => {
      const store = await readStore();
      const outcome = change(store);
      if (outcome?.wrote !== false) await writeStore(store);
      return outcome?.result;
    });
    chain = next;
    return next;
  };

  const trackerIn = (store, providerId) => {
    store.trackers[providerId] ??= emptyTracker();
    return store.trackers[providerId];
  };

  /** The account under `accountId` when its revision is still `expectedRevision` (or no revision was asked for). */
  const accountAt = (tracker, accountId, expectedRevision) => {
    const account = tracker?.accounts.find((candidate) => candidate.id === accountId) ?? null;
    if (!account) return null;
    return expectedRevision === undefined || account.revision === expectedRevision ? account : null;
  };

  return Object.freeze({
    /** The identity of a connect about to verify; `connect` commits only while it is the latest for the provider. */
    beginConnect: (providerId) => {
      const connection = Symbol('connect');
      pendingConnections.set(providerId, connection);
      return connection;
    },
    /** Drops the pending connect; with `expected`, only when it is still that one, so a late answer cancels nothing newer. */
    cancelConnect: (providerId, expected) => {
      if (expected !== undefined && pendingConnections.get(providerId) !== expected) return false;
      return pendingConnections.delete(providerId);
    },

    /** The stored tracker with its credentials, for minting a handle; null when nothing is stored. */
    read: async (providerId) => (await readStore()).trackers[providerId] ?? null,
    publicView: async (providerId) => publicViewOf((await readStore()).trackers[providerId] ?? null),
    /** Every stored tracker's public view, by provider id. */
    list: async () => Object.fromEntries(Object.entries((await readStore()).trackers).map(([id, tracker]) => [id, publicViewOf(tracker)])),

    /**
     * An account the service verified, on `instance`: added, or replaced when
     * the tracker already knows its id, and made current. Refused under
     * `INSTANCE_MISMATCH` when other accounts live on another server; the
     * user disconnects them first. `null` when a newer account action
     * (a disconnect, a later connect) replaced this connection.
     */
    connect: (providerId, { instance, account, credential }, expectedConnection) => mutate((store) => {
      if (expectedConnection !== undefined && pendingConnections.get(providerId) !== expectedConnection) return { wrote: false, result: null };
      pendingConnections.delete(providerId);
      const tracker = trackerIn(store, providerId);
      if (tracker.instance && tracker.instance !== instance && tracker.accounts.length > 0) {
        throw conflict('INSTANCE_MISMATCH', `The connected accounts live on ${tracker.instance}; disconnect them before connecting to ${instance}.`);
      }
      if (tracker.accounts.length >= TRACKER_ACCOUNTS_MAX && !tracker.accounts.some((candidate) => candidate.id === account.id)) {
        throw conflict('ACCOUNTS_FULL', `At most ${TRACKER_ACCOUNTS_MAX} accounts per tracker.`);
      }
      const stored = {
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

    /**
     * The OAuth client the user entered, bound to the endpoints it was
     * entered for. An empty secret keeps the stored one only for the same
     * client id and the same endpoints. Refused under `INSTANCE_MISMATCH`
     * like a connect.
     */
    setClient: (providerId, { instance, clientId, clientSecret, target }) => mutate((store) => {
      const tracker = trackerIn(store, providerId);
      if (tracker.instance && tracker.instance !== instance && tracker.accounts.length > 0) {
        throw conflict('INSTANCE_MISMATCH', `The connected accounts live on ${tracker.instance}; disconnect them before connecting to ${instance}.`);
      }
      const previous = tracker.client;
      const client = { id: clientId, target: { ...target } };
      if (clientSecret) client.secret = clientSecret;
      else if (previous?.secret && previous.id === clientId && sameTarget(previous.target, target)) client.secret = previous.secret;
      tracker.instance = instance;
      tracker.client = client;
      return { result: publicViewOf(tracker) };
    }),

    /** The client entered for exactly these endpoints, else null: a moved package gets no old secret. */
    readClient: async (providerId, target) => {
      const client = (await readStore()).trackers[providerId]?.client;
      return client && sameTarget(client.target, target) ? { id: client.id, secret: client.secret ?? '' } : null;
    },

    /** Makes a stored, valid account current. False when there is no such account. */
    activate: (providerId, accountId) => mutate((store) => {
      const tracker = store.trackers[providerId];
      const account = tracker?.accounts.find((candidate) => candidate.id === accountId && candidate.status === 'valid');
      if (!account) return { wrote: false, result: false };
      tracker.activeAccountId = accountId;
      return { result: true };
    }),

    /** Disconnect one account; the last one leaving forgets the server with it. A pending connect loses. */
    removeAccount: (providerId, accountId) => {
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

    /** The server refused the account's credential: it stays, marked, until the user connects again. Only the revision it was read at. */
    markInvalid: (providerId, accountId, reason, expectedRevision) => mutate((store) => {
      const tracker = store.trackers[providerId];
      const account = accountAt(tracker, accountId, expectedRevision);
      if (!account) return { wrote: false, result: false };
      account.status = 'invalid';
      account.invalidReason = reason;
      if (tracker.activeAccountId === accountId) {
        tracker.activeAccountId = tracker.accounts.find((candidate) => candidate.status === 'valid')?.id ?? accountId;
      }
      return { result: true };
    }),

    /** A refreshed OAuth credential, committed only against the revision the refresh started from. Answers the new revision, or null. */
    updateCredential: (providerId, accountId, credential, expectedRevision) => mutate((store) => {
      const account = accountAt(store.trackers[providerId], accountId, expectedRevision);
      if (!account) return { wrote: false, result: null };
      account.credential = credential;
      account.revision = randomUUID();
      account.status = 'valid';
      delete account.invalidReason;
      return { result: account.revision };
    }),

    mapping: async (providerId) => (await readStore()).trackers[providerId]?.mapping ?? { defaultProjectPath: null, containerProjectPaths: {} },
    setMapping: (providerId, { defaultProjectPath, containerProjectPaths }) => mutate((store) => {
      const tracker = store.trackers[providerId];
      if (!tracker) return { wrote: false, result: null };
      tracker.mapping = { defaultProjectPath: defaultProjectPath ?? null, containerProjectPaths: { ...containerProjectPaths } };
      return { result: tracker.mapping };
    }),

    /** Status comments stay off until the user turns them on. */
    preferences: async (providerId) => (await readStore()).trackers[providerId]?.preferences ?? { sessionComments: false },
    setPreferences: (providerId, { sessionComments }) => mutate((store) => {
      const tracker = store.trackers[providerId];
      if (!tracker) return { wrote: false, result: { sessionComments: false } };
      tracker.preferences = { sessionComments: sessionComments === true };
      return { result: tracker.preferences };
    }),

    sessionRecord: async (providerId, sessionId) => (await readStore()).trackers[providerId]?.sessions?.[sessionId] ?? null,
    /**
     * Writes one session's record and keeps the newest `TRACKER_SESSION_RECORDS_MAX`.
     * Kind flags merge with what is stored: two posts in flight at once (a failed
     * turn emits `failure` and `completed` together) each read the record before
     * the other wrote, and neither may lose the other's flag. No section is created:
     * a post that finishes after removal leaves nothing behind.
     */
    writeSessionRecord: (providerId, sessionId, record) => mutate((store) => {
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
        ? Object.fromEntries(keys.slice(keys.length - TRACKER_SESSION_RECORDS_MAX).map((key) => [key, sessions[key]]))
        : sessions;
      return { result: record };
    }),

    /** "Remove means forget": everything stored for an uninstalled extension's tracker. */
    remove: (providerId) => {
      pendingConnections.delete(providerId);
      return mutate((store) => {
        const had = Boolean(store.trackers[providerId]);
        delete store.trackers[providerId];
        return { wrote: had, result: had };
      });
    },
  });
};
