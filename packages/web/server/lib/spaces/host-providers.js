// The providers the user defined in the host's OpenCode configuration, "custom" in Settings, as a
// space can be given them (see "Grants" in DOCUMENTATION.md): a self-hosted gateway or a model
// server on the user's own machine or network, which OpenCode's catalog does not know, with the
// models the user listed for it. The host reads the definition again at every grant and every
// start, so a provider edited in Settings reaches the space at its next start, and nothing of it
// is kept in the record.
//
// The key is resolved the way OpenCode resolves it for the host, measured on 2.0.26: the credential
// stored for the provider wins, then the first set variable the entry's `env` names, then a literal
// `apiKey` in its settings. A provider that has none is given with no key: the window then forwards
// the request as the space made it, less its credential headers.

import { z } from 'zod';

import { isRecord, readSectionEntry, toProviderEntity } from '../opencode/config-v2.js';
import { readConfigLayers } from '../opencode/shared.js';
import { HOST_NAME } from './hardening.js';

// The header the window sets for a provider, by the SDK its entry names: what that SDK's API
// reads a key from. OpenCode's `aisdk:` prefix is the canonical spelling in a v2 entry.
const HEADER_BY_PACKAGE = new Map([
  ['aisdk:@ai-sdk/openai-compatible', 'authorization'],
  ['aisdk:@ai-sdk/openai', 'authorization'],
  ['aisdk:@ai-sdk/anthropic', 'x-api-key'],
]);

/** The header a custom provider's key travels in, or null for an SDK the window does not know. */
export const headerOfPackage = (packageName) => HEADER_BY_PACKAGE.get(packageName) ?? null;

// "This machine" as a base URL names it: the Docker host, which the gatekeeper reaches under
// `host.docker.internal`, while inside the gatekeeper these names would be the gatekeeper itself.
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '0.0.0.0']);

/**
 * The address the window forwards a custom provider's requests to: the base URL as the user wrote
 * it, with a loopback host replaced by the Docker host's name. Null for anything that is not an
 * http(s) URL.
 */
export const windowUpstreamOf = (baseURL) => {
  const url = httpUrlOf(baseURL);
  if (!url) return null;
  if (isLoopback(url)) url.hostname = HOST_NAME;
  return url.toString();
};

/** Whether a base URL names "this machine", which inside the gatekeeper would be the gatekeeper. */
export const isLoopbackUrl = (baseURL) => {
  const url = httpUrlOf(baseURL);
  return url !== null && isLoopback(url);
};

// Any 127/8 address is this machine, as `localhost` is.
const isLoopback = (url) => LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || /^127\./.test(url.hostname);

const httpUrlOf = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return /^https?:$/.test(url.protocol) ? url : null;
};

/** The layers of a directory, highest precedence first: custom, project, the user's override file, the user's file. */
const layersOf = (readLayers, directory) => {
  const { userConfig, userOverrideConfig, projectConfig, customConfig } = readLayers(directory);
  return [customConfig, projectConfig, userOverrideConfig, userConfig];
};

// A provider id a grant can name, the record's own rule; an id outside it, hand-written in the
// configuration, is left out of the list rather than offered and refused.
const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Every provider id the layers define under either spelling, once, that a grant can name. */
const definedIds = (layers) => {
  const ids = new Set();
  for (const layer of layers) {
    for (const key of ['providers', 'provider']) {
      const section = layer?.[key];
      if (isRecord(section)) for (const id of Object.keys(section)) if (GRANT_ID_PATTERN.test(id)) ids.add(id);
    }
  }
  return ids;
};

/** A key as a value is one: text with something in it. */
const keySchema = z.string().min(1);
const keyOf = (value) => keySchema.safeParse(value).data ?? null;

/**
 * `readLayers(directory)` is `readConfigLayers` of the host's OpenCode configuration, injectable
 * for the tests; `readStoredKey(providerId)` answers the key OpenCode stores for a provider, or
 * null, and `hostEnvironment` is where a variable the entry's `env` names is read.
 */
export function createHostProviders({ readLayers = readConfigLayers, readStoredKey = async () => null, hostEnvironment = process.env } = {}) {
  /** The winning entry for a provider in v2 shape, or null when no layer defines it with an SDK. */
  const entryOf = (layers, providerId) => {
    for (const layer of layers) {
      const { value } = readSectionEntry(layer, 'providers', providerId);
      if (value === undefined) continue;
      const entity = toProviderEntity(value);
      return entity.package ? entity : null;
    }
    return null;
  };

  const definition = (providerId, entity) => ({
    id: providerId,
    name: entity.name ?? providerId,
    package: entity.package,
    baseURL: entity.settings?.baseURL ?? null,
    headers: entity.headers ?? {},
    models: entity.models ?? {},
  });

  const resolveKey = async (providerId, entity, { storedKey = readStoredKey } = {}) => {
    const stored = keyOf(await storedKey(providerId));
    if (stored !== null) return stored;
    for (const name of entity.env ?? []) {
      const value = keyOf(hostEnvironment[name]);
      if (value !== null) return value;
    }
    return keyOf(entity.settings?.apiKey);
  };

  /**
   * One custom provider of the directory's configuration with its key, or null when none defines
   * it. The key is the only secret here and goes to the gatekeeper and nowhere else.
   */
  const read = async (providerId, directory) => {
    const entity = entryOf(layersOf(readLayers, directory), providerId);
    if (!entity) return null;
    return { ...definition(providerId, entity), key: await resolveKey(providerId, entity) };
  };

  /**
   * Every custom provider of the directory's configuration as a grant dialog shows it, without a
   * key: whether the host has one for it, and what keeps the grant from being given, if anything.
   */
  const list = async (directory) => {
    const layers = layersOf(readLayers, directory);
    const providers = [];
    // The stored keys live in the host's OpenCode, which may not be up when a dialog opens: the
    // list then says what the configuration alone says, and a grant, which needs the key, asks again.
    const storedKey = async (providerId) => readStoredKey(providerId).catch(() => null);
    for (const providerId of definedIds(layers)) {
      const entity = entryOf(layers, providerId);
      if (!entity) continue;
      const { headers: _headers, models, ...rest } = definition(providerId, entity);
      providers.push({
        ...rest,
        // Whether the address names the machine the space runs on: the dialogs say so under a machine over SSH.
        loopback: rest.baseURL !== null && isLoopbackUrl(rest.baseURL),
        models: Object.keys(models),
        hasKey: (await resolveKey(providerId, entity, { storedKey })) !== null,
        // What a grant checks too: an SDK the window can carry a key for, and an http(s) address.
        supported: headerOfPackage(entity.package) !== null && rest.baseURL !== null && httpUrlOf(rest.baseURL) !== null,
      });
    }
    return providers;
  };

  return { read, list };
}
