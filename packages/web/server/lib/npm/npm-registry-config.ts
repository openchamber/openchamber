import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export interface NpmRegistryRequest {
  url: string;
  headers: Record<string, string>;
}

function configPath() {
  const configured = [process.env.npm_config_userconfig, process.env.NPM_CONFIG_USERCONFIG]
    .map((value) => value?.trim())
    .find(Boolean);
  return configured || path.join(os.homedir(), '.npmrc');
}

function unquote(value: string) {
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
  return quoted ? value.slice(1, -1) : value;
}

function configValues() {
  try {
    const values = new Map<string, string>();
    for (const rawLine of fs.readFileSync(configPath(), 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

      const separator = line.indexOf('=');
      if (separator < 1) continue;
      values.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
    }
    return values;
  } catch {
    return new Map<string, string>();
  }
}

function configuredValue(values: ReadonlyMap<string, string>, key: string) {
  const configured = values.get(key);
  if (!configured) return configured;

  return configured.replace(/\$\{([^}]+)\}/g, (_match: string, variable: string) => {
    const value = process.env[variable];
    if (value === undefined) throw new Error('Missing npm configuration environment variable');
    return value;
  });
}

function registryFor(packageName: string, values: ReadonlyMap<string, string>) {
  const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : null;
  const scopedEnvironmentRegistry = scope && [
    process.env[`npm_config_${scope}:registry`],
    process.env[`NPM_CONFIG_${scope}:REGISTRY`],
  ].map((value) => value?.trim()).find(Boolean);
  if (scopedEnvironmentRegistry) return scopedEnvironmentRegistry;

  const scopedRegistry = scope && configuredValue(values, `${scope}:registry`);
  if (scopedRegistry) return scopedRegistry;

  const environmentRegistry = [process.env.npm_config_registry, process.env.NPM_CONFIG_REGISTRY]
    .map((value) => value?.trim())
    .find(Boolean);
  if (environmentRegistry) return environmentRegistry;

  return configuredValue(values, 'registry') || DEFAULT_NPM_REGISTRY;
}

function authFor(registry: URL, values: ReadonlyMap<string, string>): NpmRegistryRequest['headers'] {
  const registryScope = `//${registry.host}${registry.pathname.replace(/\/+$/, '')}/`;
  let bestMatch: string | null = null;

  for (const key of values.keys()) {
    const match = /^(\/\/.*\/):(?:_authToken|_auth|username|_password)$/.exec(key);
    const prefix = match?.[1];
    if (prefix !== undefined && registryScope.startsWith(prefix) && (!bestMatch || prefix.length > bestMatch.length)) {
      bestMatch = prefix;
    }
  }

  if (!bestMatch) return {};

  const token = configuredValue(values, `${bestMatch}:_authToken`);
  if (token) return { Authorization: `Bearer ${token}` };

  const authorization = configuredValue(values, `${bestMatch}:_auth`);
  if (authorization) return { Authorization: `Basic ${authorization}` };

  const username = configuredValue(values, `${bestMatch}:username`);
  const password = configuredValue(values, `${bestMatch}:_password`);
  if (username && password) {
    const decodedPassword = Buffer.from(password, 'base64').toString('utf8');
    return { Authorization: `Basic ${Buffer.from(`${username}:${decodedPassword}`).toString('base64')}` };
  }

  return {};
}

export function resolveNpmRegistryRequest(packageName: string, metadataPath?: string): NpmRegistryRequest {
  const values = configValues();
  let registry;
  try {
    registry = new URL(registryFor(packageName, values));
    if (!['http:', 'https:'].includes(registry.protocol) || registry.search || registry.hash) {
      throw new Error('invalid registry');
    }
  } catch {
    throw new Error('Invalid npm registry URL');
  }

  const headers = authFor(registry, values);
  if (!headers.Authorization && (registry.username || registry.password)) {
    try {
      headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(registry.username)}:${decodeURIComponent(registry.password)}`).toString('base64')}`;
    } catch {
      throw new Error('Invalid npm registry URL');
    }
  }
  registry.username = '';
  registry.password = '';
  registry.pathname = `${registry.pathname.replace(/\/+$/, '')}/`;

  return {
    url: `${registry.toString()}${encodeURIComponent(packageName).replace(/^%40/i, '@')}${metadataPath ? `/${encodeURIComponent(metadataPath)}` : ''}`,
    headers,
  };
}
