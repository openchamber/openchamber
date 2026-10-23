import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getGitHubAuthByAccountId } from '../github/auth.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { BotServiceError, jiraOrigin, opaqueId, parse, revision, snowflake, text } from './services/contracts.js';

const secret = z.string().min(1).max(32_768).refine((value) => !/[\x00\r\n]/.test(value));
const common = { label: text };
const definitions = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('github-account'), accountId: text, credentialRevision: revision }).strict(),
  z.object({ ...common, kind: z.literal('github-app'), appId: z.string().regex(/^[1-9][0-9]*$/),
    installationId: z.string().regex(/^[1-9][0-9]*$/), privateKey: z.string().min(1).max(32_768) }).strict(),
  z.object({ ...common, kind: z.enum(['jira-account', 'jira-service']), site: text,
    email: z.string().email().max(320), apiToken: secret }).strict(),
  z.object({ ...common, kind: z.literal('discord-app'), applicationId: snowflake, botToken: secret }).strict(),
]);
const storedIdentity = z.object({ id: opaqueId, revision, definition: definitions }).strict();
const stateSchema = z.object({ version: z.literal(1), identities: z.array(storedIdentity).max(200) }).strict()
  .refine((value) => new Set(value.identities.map((entry) => entry.id)).size === value.identities.length);
const unavailable = () => new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'Reconnect or select the exact bot identity.');
const publicIdentity = ({ id, revision: identityRevision, definition }) => {
  const result = { id, revision: identityRevision, label: definition.label, kind: definition.kind, configured: true };
  for (const key of ['accountId', 'credentialRevision', 'appId', 'installationId', 'site', 'email', 'applicationId']) {
    if (definition[key] !== undefined) result[key] = definition[key];
  }
  return result;
};

export function createBotIdentityStore({
  dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber'),
  fsImpl = fs, readGitHubAccount = getGitHubAuthByAccountId,
} = {}) {
  const filePath = path.join(dataDir, 'bot-identities.json');
  let transactions = Promise.resolve();
  const transaction = (operation) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl }));
    transactions = next.catch(() => {});
    return next;
  };
  const readState = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, identities: [] };
      throw new BotServiceError('BOT_IDENTITIES_UNREADABLE', 'Bot identities could not be read.', 'needs-you', 500);
    }
    try { return stateSchema.parse(JSON.parse(encoded)); }
    catch { throw new BotServiceError('BOT_IDENTITIES_INVALID', 'Bot identity storage is invalid.', 'needs-you', 500); }
  };
  const writeState = async (state) => {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.mkdir(dataDir, { recursive: true });
      await fsImpl.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw new BotServiceError('BOT_IDENTITIES_WRITE_FAILED', 'Bot identity update failed. The previous identity is unchanged.', 'needs-you', 500);
    }
  };
  const validateDefinition = async (value) => {
    const definition = parse(definitions, value);
    if (definition.kind === 'github-account') {
      const account = await readGitHubAccount(definition.accountId, definition.credentialRevision);
      if (!account || account.credentialId !== definition.accountId
        || account.credentialRevision !== definition.credentialRevision) throw unavailable();
    }
    if (definition.kind === 'github-app') {
      try {
        const key = createPrivateKey(definition.privateKey);
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
      } catch { throw new BotServiceError('BOT_APP_KEY_INVALID', 'A valid RSA GitHub App private key is required.', 'failed', 400); }
    }
    if (definition.kind.startsWith('jira-')) definition.site = jiraOrigin(definition.site);
    return definition;
  };
  return Object.freeze({
    list: () => transaction(async () => (await readState()).identities.map(publicIdentity)),
    create: async (value) => {
      const definition = await validateDefinition(value);
      return transaction(async () => {
        const state = await readState();
        if (state.identities.length >= 200) throw new BotServiceError('BOT_IDENTITY_CAPACITY', 'Bot identity storage is full.');
        const identity = { id: randomUUID(), revision: 1, definition };
        state.identities.push(identity);
        await writeState(state);
        return publicIdentity(identity);
      });
    },
    update: async (id, expectedRevision, value) => {
      parse(opaqueId, id); parse(revision, expectedRevision);
      const definition = await validateDefinition(value);
      return transaction(async () => {
        const state = await readState();
        const identity = state.identities.find((entry) => entry.id === id);
        if (!identity || identity.revision !== expectedRevision) throw unavailable();
        identity.revision += 1;
        identity.definition = definition;
        await writeState(state);
        return publicIdentity(identity);
      });
    },
    remove: (id, expectedRevision) => transaction(async () => {
      parse(opaqueId, id); parse(revision, expectedRevision);
      const state = await readState();
      const index = state.identities.findIndex((entry) => entry.id === id && entry.revision === expectedRevision);
      if (index < 0) throw unavailable();
      state.identities.splice(index, 1);
      await writeState(state);
      return { removed: true };
    }),
    // Server-only. Routes use list/create/update/remove, never this secret-bearing method.
    resolve: (id, expectedRevision) => transaction(async () => {
      parse(opaqueId, id); parse(revision, expectedRevision);
      const identity = (await readState()).identities.find((entry) => entry.id === id && entry.revision === expectedRevision);
      if (!identity) throw unavailable();
      if (identity.definition.kind.startsWith('jira-')) identity.definition.site = jiraOrigin(identity.definition.site);
      return identity;
    }),
    readGitHubAccount,
  });
}
