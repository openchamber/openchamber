import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isProviderId } from './provider-id.js';

const VERSION = 1;
export const MAX_INSTANCE_ALIASES = 8;

const invalidState = (cause) => Object.assign(new Error('Source control instance aliases storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_INSTANCE_ALIASES',
});

const invalidAlias = (alias) => Object.assign(new Error(`Not a web address: ${alias}`), {
  code: 'INVALID_INSTANCE_ALIAS', alias,
});

const normalizeHostAlias = (raw) => {
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { throw invalidAlias(raw); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || (url.pathname && url.pathname !== '/')) throw invalidAlias(raw);
  return url.hostname.toLowerCase().replace(/\.$/, '');
};

export function normalizeInstanceAlias(form, value) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw invalidAlias(String(value ?? ''));
  if (form === 'host') return normalizeHostAlias(raw);
  try { return normalizeOriginInstance(raw, { label: 'Alias' }); }
  catch { throw invalidAlias(raw); }
}

export function instanceHostname(instance) {
  try { return new URL(instance.includes('://') ? instance : `https://${instance}`).hostname.toLowerCase(); }
  catch { return instance.toLowerCase(); }
}

const parseState = (value) => {
  if (!isPlainObject(value) || value.version !== VERSION || !isPlainObject(value.providers)
    || Object.keys(value).some((key) => key !== 'version' && key !== 'providers')) throw invalidState();
  const providers = {};
  for (const [provider, instances] of Object.entries(value.providers)) {
    if (!isProviderId(provider) || !isPlainObject(instances)) throw invalidState();
    providers[provider] = {};
    for (const [instance, aliases] of Object.entries(instances)) {
      if (!instance || !Array.isArray(aliases) || !aliases.length || aliases.length > MAX_INSTANCE_ALIASES
        || aliases.some((alias) => !isString(alias) || !alias || alias.trim() !== alias)) throw invalidState();
      providers[provider][instance] = [...aliases];
    }
  }
  return { version: VERSION, providers };
};

export function createInstanceAliasStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }) {
  let transactions = Promise.resolve();
  const transaction = (operation) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    transactions = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return { version: VERSION, providers: {} };
      throw error;
    }
    let value;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    return parseState(value);
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  return Object.freeze({
    list: async () => (await readState()).providers,
    set: (provider, instance, aliases, check) => transaction(async () => {
      const state = await readState();
      check?.(state.providers);
      const instances = state.providers[provider] ?? {};
      if (aliases.length) instances[instance] = [...aliases];
      else delete instances[instance];
      if (Object.keys(instances).length) state.providers[provider] = instances;
      else delete state.providers[provider];
      await writeState(state);
      return [...aliases];
    }),
  });
}
