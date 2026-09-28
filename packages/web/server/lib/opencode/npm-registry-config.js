import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

function configPath() {
  const configured = [process.env.npm_config_userconfig, process.env.NPM_CONFIG_USERCONFIG]
    .map((value) => value?.trim())
    .find(Boolean);
  return configured || path.join(os.homedir(), '.npmrc');
}

// npm's ini parser accepts `key = "value"`; the quotes are not part of the value.
function unquote(value) {
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
  return quoted ? value.slice(1, -1) : value;
}

function configValues() {
  try {
    const values = new Map();
    for (const rawLine of fs.readFileSync(configPath(), 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

      const separator = line.indexOf('=');
      if (separator < 1) continue;
      values.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
    }
    return values;
  } catch {
    return new Map();
  }
}

function configuredValue(values, key) {
  const configured = values.get(key);
  if (!configured) return configured;

  return configured.replace(/\$\{([^}]+)\}/g, (_match, variable) => {
    const value = process.env[variable];
    if (value === undefined) throw new Error('Missing npm configuration environment variable');
    return value;
  });
}

function registryFor(packageName, values) {
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

function authFor(registry, values) {
  const registryScope = `//${registry.host}${registry.pathname.replace(/\/+$/, '')}/`;
  let bestMatch = null;

  for (const key of values.keys()) {
    const match = /^(\/\/.*\/):(?:_authToken|_auth|username|_password)$/.exec(key);
    if (match && registryScope.startsWith(match[1]) && (!bestMatch || match[1].length > bestMatch.length)) {
      bestMatch = match[1];
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

/**
 * Build a credential-safe package metadata request using npm's standard user configuration.
 *
 * @param {string} packageName
 * @returns {{ url: string, headers: Record<string, string> }}
 */
export function resolveNpmRegistryRequest(packageName) {
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
  registry.username = '';
  registry.password = '';
  registry.pathname = `${registry.pathname.replace(/\/+$/, '')}/`;

  return {
    url: `${registry.toString()}${encodeURIComponent(packageName).replace(/^%40/i, '@')}`,
    headers,
  };
}
