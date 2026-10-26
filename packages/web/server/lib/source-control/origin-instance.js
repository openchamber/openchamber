import { isString } from '../shared/guards.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase());

/**
 * An instance identified by its URL origin (GitLab and other self-hostable
 * providers): HTTPS, or HTTP on a loopback host for local deployments and
 * tests; no credentials, path, query, or fragment. `label` names the provider
 * in the errors a person reads.
 */
export function normalizeOriginInstance(value, { label }) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw new Error(`${label} instance is required`);

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid ${label} instance URL`);
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error(`${label} instance must be an origin`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} instances must use HTTPS`);
  }
  return url.origin;
}

const webPort = (url) => Number(url.port || (url.protocol === 'http:' ? 80 : 443));

/**
 * The known origin a remote's host belongs to. `port` is the remote's web
 * port when the remote is an HTTP(S) URL, so two instances on one host with
 * different ports stay apart; an SSH remote names no web port, so its host
 * alone decides and the first known origin there wins.
 */
export function ownedOriginInstance({ host, port, knownInstances }) {
  const name = String(host ?? '').toLowerCase();
  return knownInstances.find((origin) => {
    let url;
    try { url = new URL(origin); } catch { return false; }
    return url.hostname === name && (port === undefined || webPort(url) === port);
  }) ?? null;
}
