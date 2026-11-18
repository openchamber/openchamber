import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasSourceControlErrorCode, isSourceControlObject as isPlainObject, isSourceControlString as isString } from './input-guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isProviderId } from './provider-id.js';
import type { ProviderDescriptor } from './provider-contract.js';

export interface InstanceAliasSnapshot {
  version: number;
  providers: Record<string, Record<string, string[]>>;
}

interface InstanceAliasStoreOptions {
  filePath: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
}

const VERSION = 1;
export const MAX_INSTANCE_ALIASES = 8;

const invalidState = (cause?: ErrorOptions['cause']) => Object.assign(new Error('Source control instance aliases storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_INSTANCE_ALIASES',
});

const invalidAlias = (alias: string) => Object.assign(new Error(`Not a web address: ${alias}`), {
  code: 'INVALID_INSTANCE_ALIAS', alias,
});

const normalizeHostAlias = (raw: string) => {
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { throw invalidAlias(raw); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || (url.pathname && url.pathname !== '/')) throw invalidAlias(raw);
  return url.hostname.toLowerCase().replace(/\.$/, '');
};

export function normalizeInstanceAlias(form: ProviderDescriptor['instance']['form'], value: string) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw invalidAlias(String(value ?? ''));
  if (form === 'host') return normalizeHostAlias(raw);
  try { return normalizeOriginInstance(raw, { label: 'Alias' }); }
  catch { throw invalidAlias(raw); }
}

export function instanceHostname(instance: string) {
  try { return new URL(instance.includes('://') ? instance : `https://${instance}`).hostname.toLowerCase(); }
  catch { return instance.toLowerCase(); }
}

const validAliases = (aliases: unknown): aliases is string[] => Array.isArray(aliases) && aliases.length > 0
  && aliases.length <= MAX_INSTANCE_ALIASES
  && !aliases.some((alias) => !isString(alias) || !alias || alias.trim() !== alias);

const isAliasSnapshot = (value: unknown): value is InstanceAliasSnapshot => {
  if (!isPlainObject(value) || !('version' in value) || !('providers' in value)
    || value.version !== VERSION || !isPlainObject(value.providers)
    || Object.keys(value).some((key) => key !== 'version' && key !== 'providers')) return false;
  for (const [provider, instances] of Object.entries(value.providers)) {
    if (!isProviderId(provider) || !isPlainObject(instances)) return false;
    for (const [instance, aliases] of Object.entries(instances)) {
      if (!instance || !validAliases(aliases)) return false;
    }
  }
  return true;
};

const parseState = (value: InstanceAliasSnapshot) => {
  const providers: InstanceAliasSnapshot['providers'] = {};
  for (const [provider, instances] of Object.entries(value.providers)) {
    const parsed: Record<string, string[]> = {};
    providers[provider] = parsed;
    for (const [instance, aliases] of Object.entries(instances)) {
      parsed[instance] = [...aliases];
    }
  }
  return { version: VERSION, providers };
};

export function createInstanceAliasStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }: InstanceAliasStoreOptions) {
  let transactions = Promise.resolve();
  const transaction = <Result>(operation: () => Promise<Result>) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    transactions = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async (): Promise<InstanceAliasSnapshot> => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return { version: VERSION, providers: {} };
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    if (!isAliasSnapshot(value)) throw invalidState();
    return parseState(value);
  };
  const writeState = async (state: InstanceAliasSnapshot) => {
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
    set: (provider: string, instance: string, aliases: string[], check?: (providers: InstanceAliasSnapshot['providers']) => void) => transaction(async () => {
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
