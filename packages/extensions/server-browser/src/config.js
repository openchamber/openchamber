import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isPrivateAddress } from './policy-proxy.js';
import { createOriginRefusal } from './origin-refusal.js';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const parseAllowedOrigin = (value, index) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`config.allowedOrigins[${index}] must be a non-empty origin`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`config.allowedOrigins[${index}] is not a valid URL origin`);
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`config.allowedOrigins[${index}] must be an http(s) origin without credentials, path, query, or hash`);
  }
  return url.origin;
};

const parsePorts = (value, label) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}.ports must be a non-empty array`);
  return Object.freeze(value.map((entry, index) => {
    const range = typeof entry === 'string' ? /^(\d+)(?:-(\d+))?$/.exec(entry) : null;
    const [first, last] = range ? [Number(range[1]), Number(range[2] ?? range[1])] : [entry, entry];
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65_535 || first > last) {
      throw new Error(`${label}.ports[${index}] must be a port or a "first-last" range`);
    }
    return Object.freeze([first, last]);
  }));
};

const parseAllowedNetwork = (value, index) => {
  const label = `config.allowedNetworks[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with cidr and ports`);
  }
  const cidr = typeof value.cidr === 'string' ? /^([\d.]+)\/(\d+)$/.exec(value.cidr) : null;
  const prefix = Number(cidr?.[2]);
  if (!cidr || !net.isIPv4(cidr[1]) || prefix < 8 || prefix > 32 || !isPrivateAddress(cidr[1])) {
    throw new Error(`${label}.cidr must be a private or loopback IPv4 block from /8 to /32, such as 192.168.1.0/24`);
  }
  return Object.freeze({ cidr: value.cidr, address: cidr[1], prefix, ports: parsePorts(value.ports, label) });
};

// A built-in has no user-editable package directory an installed-from-folder
// extension would have had, so configuration no longer lives beside the
// package. It lives where the profile key file already did: the user's own
// XDG config directory, shared across every OpenChamber instance on the
// machine, same file name a folder install of the community extension used.
// An instance that passes its own data directory (`OPENCHAMBER_DATA_DIR`,
// not yet forwarded to services by every host) may add a second file there
// for per-instance overrides on a box running more than one OpenChamber;
// its keys win over the user-wide file.
export const defaultConfigPaths = (env = process.env) => {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    userConfigPath: path.join(configHome, 'openchamber-server-browser', 'config.json'),
    instanceConfigPath: env.OPENCHAMBER_DATA_DIR ? path.join(env.OPENCHAMBER_DATA_DIR, 'server-browser.json') : null,
  };
};

const readConfigFile = (filePath) => {
  if (!filePath) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return value;
};

export const parseConfig = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json must contain an object');
  }
  const chromePath = value.chromePath;
  if (chromePath !== undefined && (typeof chromePath !== 'string' || chromePath.trim().length === 0)) {
    throw new Error('config.chromePath must be a non-empty string when provided');
  }
  if (value.allowedOrigins !== undefined && !Array.isArray(value.allowedOrigins)) {
    throw new Error('config.allowedOrigins must be an array');
  }
  if (value.allowedNetworks !== undefined && !Array.isArray(value.allowedNetworks)) {
    throw new Error('config.allowedNetworks must be an array');
  }
  for (const name of ['discoverDevServers', 'projectDevServers', 'allowPrivateNetwork']) {
    if (value[name] !== undefined && typeof value[name] !== 'boolean') {
      throw new Error(`config.${name} must be true or false`);
    }
  }
  for (const name of ['profileStore', 'profileKeyFile']) {
    if (value[name] !== undefined && (typeof value[name] !== 'string' || !path.isAbsolute(value[name].trim()))) {
      throw new Error(`config.${name} must be an absolute path when provided`);
    }
  }
  const allowedOrigins = (value.allowedOrigins ?? []).map(parseAllowedOrigin);
  return Object.freeze({
    chromePath: chromePath?.trim() ?? null,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    allowedNetworks: Object.freeze((value.allowedNetworks ?? []).map(parseAllowedNetwork)),
    discoverDevServers: value.discoverDevServers === true,
    projectDevServers: value.projectDevServers !== false,
    // null: decided by where OpenChamber runs (see network-policy.js).
    allowPrivateNetwork: typeof value.allowPrivateNetwork === 'boolean' ? value.allowPrivateNetwork : null,
    profileStore: value.profileStore?.trim() ?? null,
    profileKeyFile: value.profileKeyFile?.trim() ?? null,
  });
};

export const loadConfig = ({ env = process.env, configPath, instanceConfigPath } = {}) => {
  const defaults = defaultConfigPaths(env);
  const resolvedPath = configPath ?? defaults.userConfigPath;
  // An explicit configPath (tests, a non-default install) names the whole
  // configuration by itself; the instance file only layers onto the default.
  const resolvedInstancePath = configPath !== undefined ? null : instanceConfigPath ?? defaults.instanceConfigPath;
  const merged = { ...readConfigFile(resolvedPath), ...readConfigFile(resolvedInstancePath) };
  // Only the host's dedicated field sets this policy. Neither local file nor
  // allowedOrigins can replace or relax it. Malformed host JSON stops startup.
  const openchamberOrigins = JSON.parse(env.OPENCHAMBER_BROWSER_ORIGINS ?? '[]');
  createOriginRefusal(openchamberOrigins);
  return Object.freeze({ ...parseConfig(merged), openchamberOrigins: Object.freeze(openchamberOrigins), configPath: resolvedPath, instanceConfigPath: resolvedInstancePath });
};

export const originGrants = (allowedOrigins) => allowedOrigins.map((origin) => {
  const url = new URL(origin);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol,
  };
});

export const networkGrants = (allowedNetworks) => allowedNetworks.map(({ address, prefix, ports }) => {
  const block = new net.BlockList();
  block.addSubnet(address, prefix, 'ipv4');
  return { block, ports };
});
