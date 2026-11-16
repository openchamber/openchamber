import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isProviderId } from './provider-id.js';

/**
 * Other web addresses of a provider instance: a second domain an
 * organisation serves the same host under. They only tell the client that a
 * link on that address names an item of the instance; every read still goes
 * to the instance itself, so no request and no token ever reaches an alias.
 *
 * They live in their own file, apart from `source-control-auth.json`: that
 * file's version gates what older releases can read, and a list of hostnames
 * is no reason to lock a user out of going back.
 */
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

/**
 * An alias in the spelling of the provider's instances (`form`): a bare host
 * for a host-keyed provider (GitHub), an HTTPS origin for every other one. A
 * provider's own instance rules (an extension's declared origins) do not
 * apply: nothing is ever sent to an alias.
 */
export function normalizeInstanceAlias(form, value) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw invalidAlias(String(value ?? ''));
  if (form === 'host') return normalizeHostAlias(raw);
  try { return normalizeOriginInstance(raw, { label: 'Alias' }); }
  catch { throw invalidAlias(raw); }
}

/** The hostname two addresses are compared by, whatever their form. */
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
    /**
     * `{ [provider]: { [instance]: aliases } }`; a file that does not parse is
     * refused, never read as empty. Takes no lock: writes replace the file by
     * rename, so a read sees one whole version, and listing instances never
     * leaves a lock file in a data directory nobody wrote to.
     */
    list: async () => (await readState()).providers,
    /**
     * Replaces one instance's aliases; an empty list removes the entry. The
     * caller has normalized and checked them. `check(providers)` runs inside
     * the same locked transaction, against the file as it is then, so two
     * writers cannot both take one address.
     */
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
