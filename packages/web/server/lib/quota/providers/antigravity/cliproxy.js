import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { asNonEmptyString, buildResult, resolveConfigApiKey, toNumber } from '../../utils/index.js';
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_HEADERS } from './api.js';
import { transformSummary } from './transforms.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BAN_MS = 30 * 60_000;
const FORWARDED_RESPONSE = z.object({
  status_code: z.number().int(),
  body: z.union([
    z.string().transform((text) => JSON.parse(text)),
    z.looseObject({})
  ]).pipe(z.looseObject({}))
});

const proxyOrigin = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
    // Keep localhost on numeric loopback and share its breaker with 127.0.0.1.
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.origin;
  } catch {
    return null;
  }
};

// EasyCLIProxyAPI stores these settings before the first TOML table. Only the
// top-level scalar subset is read; OAuth files and account tokens are not read.
const parseProxyConfig = (text) => {
  const values = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const match = /^(["']?)([A-Za-z0-9_-]+)\1\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#]+)\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const value = match[3];
    try {
      values[match[2]] = value.startsWith('"') ? JSON.parse(value)
        : value.startsWith("'") ? value.slice(1, -1)
          : value === 'true' || value === 'false' ? value === 'true'
            : /^\d+$/.test(value) ? Number(value) : value;
    } catch {
      // Malformed settings do not configure a source.
    }
  }
  return values;
};

const newestFirst = (a, b) => {
  const x = (a.match(/\d+/g) ?? []).map(Number);
  const y = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  }
  return 0;
};

const proxyConfigPath = (env) => {
  const explicit = asNonEmptyString(env.OC_ANTIGRAVITY_PROXY_CONFIG);
  if (explicit) return explicit;
  const local = asNonEmptyString(env.LOCALAPPDATA);
  if (!local) return null;
  const root = path.join(local, 'Programs', 'EasyCLIProxyAPI');
  try {
    const versions = fs.readdirSync(root).filter((name) => /^EasyCLIProxyAPI-v/i.test(name)).sort(newestFirst);
    for (const name of versions) {
      const candidate = path.join(root, name, 'config.toml');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // EasyCLIProxyAPI is not installed.
  }
  return null;
};

const readProxyConfig = (file) => {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return parseProxyConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Resolved for each poll so key rotation and port changes take effect without a
// restart. The management key remains in the server process.
export const resolveCliProxyAuth = (env = process.env) => {
  if (/^(off|0|false|no)$/i.test(String(env.OC_ANTIGRAVITY_PROXY ?? '').trim())) return null;
  let origin;
  let managementKey;
  if (asNonEmptyString(env.OC_ANTIGRAVITY_PROXY_URL) || asNonEmptyString(env.OC_ANTIGRAVITY_PROXY_KEY)) {
    origin = proxyOrigin(asNonEmptyString(env.OC_ANTIGRAVITY_PROXY_URL) ?? '');
    managementKey = resolveConfigApiKey(env.OC_ANTIGRAVITY_PROXY_KEY, { env });
  } else {
    const file = proxyConfigPath(env);
    const values = file ? readProxyConfig(file) : null;
    if (!values) return null;
    const host = asNonEmptyString(values.host);
    const bare = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const hostPart = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare;
    origin = proxyOrigin(`${values.tls === true ? 'https' : 'http'}://${hostPart}:${toNumber(values.port) ?? 8317}`);
    managementKey = asNonEmptyString(values['management-secret-key']);
  }
  if (!origin || !managementKey || managementKey.length > 4096 || /[\x00-\x20\x7f]/.test(managementKey)) return null;
  return {
    proxyBaseUrl: origin,
    managementKey,
    keyStamp: crypto.createHash('sha256').update(managementKey).digest('hex')
  };
};

const MESSAGES = {
  unreachable: 'CLIProxyAPI is not reachable',
  timeout: 'CLIProxyAPI quota request timed out',
  rejected: 'CLIProxyAPI rejected the management key; check management-secret-key. Not sent again until the key changes',
  banned: 'CLIProxyAPI blocks management access after rejected keys',
  token: 'CLIProxyAPI could not resolve the Antigravity token; sign in again in the proxy',
  management: 'CLIProxyAPI management request failed',
  redirect: 'CLIProxyAPI answered with a redirect, which is not followed',
  malformed: 'CLIProxyAPI returned an unexpected response',
  'no-account': 'CLIProxyAPI reports no active Antigravity account',
  'upstream-auth': 'Google rejected the Antigravity token',
  'upstream-rate': 'Google rate-limited the Antigravity quota request',
  upstream: 'Antigravity quota service failed'
};

class CliProxyError extends Error {
  constructor(kind, status = null) {
    super(MESSAGES[kind]);
    this.kind = kind;
    this.status = status;
  }
}

// CLIProxyAPI bans an address after 5 rejected management keys. A rejected key
// is sent once per origin and key version during this server process. A ban is
// address-wide, so key rotation cannot bypass its wait.
const breakers = new Map();
const checkBreaker = (source) => {
  const breaker = breakers.get(source.proxyBaseUrl);
  if (!breaker) return;
  if (breaker.kind === 'rejected' && breaker.keyStamp !== source.keyStamp) {
    breakers.delete(source.proxyBaseUrl);
    return;
  }
  if (breaker.kind === 'banned' && Date.now() >= breaker.until) {
    breakers.delete(source.proxyBaseUrl);
    return;
  }
  throw new CliProxyError(breaker.kind);
};

const banDuration = (text) => {
  const match = /Try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/.exec(text);
  const ms = match ? (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000 : 0;
  return ms > 0 ? Math.min(ms + 1000, BAN_MS + 60_000) : BAN_MS;
};

const readResponse = async (response) => {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new CliProxyError('malformed');
  }
  if (!response.body) return '';
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new CliProxyError('malformed');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const requestProxyOnce = async (source, route, payload, deadline) => {
  checkBreaker(source);
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(payload === undefined ? 5000 : 12_000)]);
  let response;
  let text;
  try {
    const init = {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${source.managementKey}` },
      redirect: 'manual',
      signal
    };
    if (payload !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    response = await fetch(`${source.proxyBaseUrl}/v0/management/${route}`, init);
    // Authentication status is authoritative even if the body never finishes.
    if (response.status === 401) {
      breakers.set(source.proxyBaseUrl, { kind: 'rejected', keyStamp: source.keyStamp });
      void response.body?.cancel().catch(() => {});
      throw new CliProxyError('rejected', 401);
    }
    if (response.status === 403) {
      breakers.set(source.proxyBaseUrl, { kind: 'banned', until: Date.now() + BAN_MS });
    }
    text = await readResponse(response);
  } catch (error) {
    if (response?.status === 403) throw new CliProxyError('banned', 403);
    if (error instanceof CliProxyError) throw error;
    throw new CliProxyError(signal.aborted ? 'timeout' : 'unreachable');
  }
  if (response.status >= 300 && response.status < 400) throw new CliProxyError('redirect', response.status);
  if (response.status === 403) {
    breakers.set(source.proxyBaseUrl, { kind: 'banned', until: Date.now() + banDuration(text) });
    throw new CliProxyError('banned', 403);
  }
  if (response.status === 400 && route === 'api-call') throw new CliProxyError('token', 400);
  if (!response.ok) throw new CliProxyError('management', response.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliProxyError('malformed');
  }
};

// The registry coalesces normal Usage polls, but the provider is also exported
// directly. Serialize management requests so overlapping callers recheck the
// breaker after the first authentication response, before sending another key.
const pendingRequests = new Map();
const requestProxy = async (source, route, payload, deadline) => {
  const previous = pendingRequests.get(source.proxyBaseUrl);
  const pending = (async () => {
    try {
      await previous;
    } catch {
      // A prior failure may have latched the breaker checked below.
    }
    return requestProxyOnce(source, route, payload, deadline);
  })();
  pendingRequests.set(source.proxyBaseUrl, pending);
  const cleanup = () => {
    if (pendingRequests.get(source.proxyBaseUrl) === pending) pendingRequests.delete(source.proxyBaseUrl);
  };
  void pending.then(cleanup, cleanup);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new CliProxyError('timeout'));
    if (deadline.aborted) onAbort();
    else deadline.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    deadline.removeEventListener('abort', onAbort);
  }
};

const selectAccount = (data) => {
  const files = Array.isArray(data) ? data : data?.files;
  if (!Array.isArray(files)) throw new CliProxyError('malformed');
  const accounts = [];
  const seen = new Set();
  for (const entry of files) {
    if (!entry || String(entry.provider ?? entry.type ?? '').trim().toLowerCase() !== 'antigravity') continue;
    if (entry.disabled === true || entry.disabled === 'true' || String(entry.status ?? '').toLowerCase() === 'disabled') continue;
    const authIndex = asNonEmptyString(entry.auth_index) ?? asNonEmptyString(entry.authIndex);
    if (!authIndex || seen.has(authIndex)) continue;
    seen.add(authIndex);
    const records = [entry, entry.metadata, entry.attributes].filter(Boolean);
    const pick = (...keys) => {
      for (const item of records) {
        for (const key of keys) {
          const value = asNonEmptyString(item[key]);
          if (value) return value;
        }
      }
      return null;
    };
    accounts.push({
      authIndex,
      email: pick('email', 'account'),
      projectId: pick('project_id', 'projectId'),
      name: asNonEmptyString(entry.name) ?? authIndex,
      ready: entry.unavailable !== true && ['', 'active'].includes(String(entry.status ?? '').toLowerCase())
    });
  }
  accounts.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
  const wanted = String(process.env.OC_ANTIGRAVITY_PROXY_ACCOUNT ?? '').trim().toLowerCase();
  const account = wanted
    ? accounts.find((item) => item.authIndex.toLowerCase() === wanted || item.email?.toLowerCase() === wanted)
    : accounts[0];
  if (!account) throw new CliProxyError('no-account');
  return account;
};

const fetchSummary = async (source, account, deadline) => {
  let last;
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    if (deadline.aborted) throw new CliProxyError('timeout');
    let wrapper;
    try {
      wrapper = await requestProxy(source, 'api-call', {
        authIndex: account.authIndex,
        method: 'POST',
        url: `${endpoint}/v1internal:retrieveUserQuotaSummary`,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          ...ANTIGRAVITY_HEADERS
        },
        data: JSON.stringify(account.projectId ? { project: account.projectId } : {})
      }, deadline);
    } catch (error) {
      if (error instanceof CliProxyError && error.kind === 'management' && error.status === 502) {
        last = error;
        continue;
      }
      throw error;
    }
    const status = wrapper?.status_code;
    if (!Number.isInteger(status)) throw new CliProxyError('malformed');
    if (status === 401 || status === 403) throw new CliProxyError('upstream-auth', status);
    if (status === 429) throw new CliProxyError('upstream-rate', status);
    if (status >= 200 && status < 300) {
      try {
        const parsed = FORWARDED_RESPONSE.safeParse(wrapper);
        if (parsed.success) return parsed.data.body;
      } catch {
        // The next stock endpoint may return a readable quota summary.
      }
      last = new CliProxyError('malformed');
      continue;
    }
    last = new CliProxyError('upstream', status);
  }
  throw last ?? new CliProxyError('malformed');
};

export const fetchCliProxyQuota = async (source, { providerId, providerName }) => {
  // The renderer has a 30-second timeout. An override can only shorten this cap.
  const override = Number(process.env.OC_ANTIGRAVITY_PROXY_DEADLINE_MS);
  const deadline = AbortSignal.timeout(override > 0 ? Math.min(Math.floor(override), 20_000) : 20_000);
  try {
    const account = selectAccount(await requestProxy(source, 'auth-files', undefined, deadline));
    const summary = await fetchSummary(source, account, deadline);
    const { modelGroupWindows } = transformSummary(summary);
    const windows = {};
    for (const group of modelGroupWindows) {
      if (!group.displayName) continue;
      const name = String(group.displayName).replace(/ models$/i, '').replace(/ and /g, ' & ');
      for (const [key, window] of Object.entries(group.windows)) {
        const label = key === '5h' ? '5-Hour' : key === 'weekly' ? 'Weekly' : key;
        windows[`${name} ${label}`] = window;
      }
    }
    if (!Object.keys(windows).length) throw new CliProxyError('malformed');
    return buildResult({ providerId, providerName, ok: true, configured: true, planLabel: account.email ?? undefined, usage: { windows } });
  } catch (error) {
    let message = 'Failed to fetch Antigravity quota via CLIProxyAPI';
    if (error instanceof CliProxyError) {
      message = error.status ? `${error.message} (HTTP ${error.status})` : error.message;
      const breaker = breakers.get(source.proxyBaseUrl);
      if (error.kind === 'banned' && breaker?.kind === 'banned') {
        message += `; next attempt in ${Math.max(1, Math.ceil((breaker.until - Date.now()) / 60_000))} min`;
      }
    }
    // Fixed messages and numeric status only. Never return proxy response bodies.
    return buildResult({ providerId, providerName, ok: false, configured: true, error: message });
  }
};
