
import { z } from 'zod';

import { isRecord, readSectionEntry, toProviderEntity } from '../opencode/config-v2.js';
import { readConfigLayers } from '../opencode/config-files.js';
import { HOST_NAME } from './hardening.js';
import type { ProviderEntity } from '../opencode/config-v2.js';
import type { OpenCodeConfigLayer, OpenCodeConfigLayers } from '../opencode/config-files.js';

export interface HostProvidersOptions {
  readLayers?: (directory: string | null) => Pick<OpenCodeConfigLayers, 'userConfig' | 'userOverrideConfig' | 'projectConfig' | 'customConfig'>;
  readStoredKey?: (providerId: string) => Promise<string | null>;
  hostEnvironment?: NodeJS.ProcessEnv;
}
type ReadLayers = NonNullable<HostProvidersOptions['readLayers']>;
type ReadStoredKey = NonNullable<HostProvidersOptions['readStoredKey']>;
export interface ProviderPackages {
  package?: ProviderEntity['package'];
  models?: ProviderEntity['models'];
}
const HEADER_BY_PACKAGE = new Map<string | undefined, string>([
  ['aisdk:@ai-sdk/openai-compatible', 'authorization'],
  ['aisdk:@ai-sdk/openai', 'authorization'],
  ['aisdk:@ai-sdk/anthropic', 'x-api-key'],
  ['@opencode/ai/providers/openai-compatible', 'authorization'],
  ['@opencode/ai/providers/openai-compatible/responses', 'authorization'],
  ['@opencode/ai/providers/openai-compatible-responses', 'authorization'],
  ['@opencode/ai/providers/openai', 'authorization'],
  ['@opencode/ai/providers/openai/chat', 'authorization'],
  ['@opencode/ai/providers/openai/responses', 'authorization'],
  ['@opencode/ai/providers/anthropic', 'x-api-key'],
  ['@opencode/ai/providers/anthropic-compatible', 'x-api-key'],
]);

export const headerOfPackage = (packageName: string | undefined) => HEADER_BY_PACKAGE.get(packageName) ?? null;

export const headerOfProvider = ({ package: packageName, models }: ProviderPackages) => {
  const header = headerOfPackage(packageName);
  if (header === null) return null;
  for (const model of Object.values(models ?? {})) {
    if (model?.package && headerOfPackage(model.package) !== header) return null;
  }
  return header;
};

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '0.0.0.0']);

export const windowUpstreamOf = <Value>(baseURL: Value) => {
  const url = httpUrlOf(baseURL);
  if (!url) return null;
  if (isLoopback(url)) url.hostname = HOST_NAME;
  return url.toString();
};

export const isLoopbackUrl = <Value>(baseURL: Value) => {
  const url = httpUrlOf(baseURL);
  return url !== null && isLoopback(url);
};

const isLoopback = (url: URL) => LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || /^127\./.test(url.hostname);

const httpUrlOf = <Value>(value: Value) => {
  let url;
  try {
    url = new URL(`${value}`);
  } catch {
    return null;
  }
  return /^https?:$/.test(url.protocol) ? url : null;
};

const layersOf = (readLayers: ReadLayers, directory: string | null) => {
  const { userConfig, userOverrideConfig, projectConfig, customConfig } = readLayers(directory);
  return [customConfig, projectConfig, userOverrideConfig, userConfig];
};

const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const definedIds = (layers: OpenCodeConfigLayer[]) => {
  const ids = new Set<string>();
  for (const layer of layers) {
    for (const key of ['providers', 'provider']) {
      const section = layer?.[key];
      if (isRecord(section)) for (const id of Object.keys(section)) if (GRANT_ID_PATTERN.test(id)) ids.add(id);
    }
  }
  return ids;
};

const keySchema = z.string().min(1);
const keyOf = <Value>(value: Value) => keySchema.safeParse(value).data ?? null;

export function createHostProviders({ readLayers = readConfigLayers, readStoredKey = async () => null, hostEnvironment = process.env }: HostProvidersOptions = {}) {
  const entryOf = (layers: OpenCodeConfigLayer[], providerId: string) => {
    for (const layer of layers) {
      const { value } = readSectionEntry(layer, 'providers', providerId);
      if (value === undefined) continue;
      const entity = toProviderEntity(value);
      return entity.package ? entity : null;
    }
    return null;
  };

  const definition = (providerId: string, entity: ProviderEntity) => ({
    id: providerId,
    name: entity.name ?? providerId,
    package: entity.package,
    baseURL: entity.settings?.baseURL ?? null,
    headers: entity.headers ?? {},
    models: entity.models ?? {},
  });

  const resolveKey = async (providerId: string, entity: ProviderEntity, { storedKey = readStoredKey }: { storedKey?: ReadStoredKey } = {}) => {
    const stored = keyOf(await storedKey(providerId));
    if (stored !== null) return stored;
    for (const name of entity.env ?? []) {
      const value = keyOf(hostEnvironment[name]);
      if (value !== null) return value;
    }
    return keyOf(entity.settings?.apiKey);
  };

  const read = async (providerId: string, directory: string | null) => {
    const entity = entryOf(layersOf(readLayers, directory), providerId);
    if (!entity) return null;
    return { ...definition(providerId, entity), key: await resolveKey(providerId, entity) };
  };

  const list = async (directory: string | null) => {
    const layers = layersOf(readLayers, directory);
    const providers = [];
    const storedKey = async (providerId: string) => readStoredKey(providerId).catch(() => null);
    for (const providerId of definedIds(layers)) {
      const entity = entryOf(layers, providerId);
      if (!entity) continue;
      const { headers: _headers, models, ...rest } = definition(providerId, entity);
      providers.push({
        ...rest,
        loopback: rest.baseURL !== null && isLoopbackUrl(rest.baseURL),
        models: Object.keys(models),
        hasKey: (await resolveKey(providerId, entity, { storedKey })) !== null,
        supported: headerOfProvider(entity) !== null && rest.baseURL !== null && httpUrlOf(rest.baseURL) !== null,
      });
    }
    return providers;
  };

  return { read, list };
}
