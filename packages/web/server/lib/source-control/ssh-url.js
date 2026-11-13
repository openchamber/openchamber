import { isString } from '../shared/guards.js';

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
// `git@host:2222`, `host`, and the userless forms. A path after the port is a
// repository remote, not an instance address, and is refused.
const BARE = /^(?:[^@/\s]+@)?(\[[0-9a-f:.]+\]|[^@:/\s?#]+)(?::(\d{1,5}))?$/i;

const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * The host and port a provider's separate SSH address names, or null. Accepts
 * `ssh://[user@]host[:port]`, `[user@]host[:port]`, and a bare `host[:port]`.
 * The username is not part of the instance: Git chooses it per remote.
 */
export function parseSshUrl(value) {
  if (!isString(value)) return null;
  const raw = value.trim();
  if (!raw) return null;

  if (raw.includes('://')) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'ssh:' || url.password || url.search || url.hash) return null;
    if (url.pathname && url.pathname !== '/') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    const port = url.port ? Number(url.port) : 22;
    return validPort(port) ? { host, port } : null;
  }

  const match = BARE.exec(raw);
  if (!match) return null;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  if (!host.includes(':') ? !HOST.test(host) : !/^\[[0-9a-f:.]+\]$/i.test(host)) return null;
  const port = match[2] ? Number(match[2]) : 22;
  return validPort(port) ? { host, port } : null;
}

/** The canonical form stored for an instance's SSH address: `ssh://host[:port]`, username dropped, port 22 omitted. */
export function normalizeSshUrl(value, { label = 'SSH' } = {}) {
  if (!isString(value) || !value.trim()) return null;
  const parsed = parseSshUrl(value);
  if (!parsed) throw new Error(`${label} SSH URL must be an SSH address, such as ssh://git@example.com:2222`);
  return parsed.port === 22 ? `ssh://${parsed.host}` : `ssh://${parsed.host}:${parsed.port}`;
}

/** Whether a remote's SSH host and port are the instance address. */
export function sshHostMatches(sshUrl, host, port) {
  const parsed = parseSshUrl(sshUrl);
  return Boolean(parsed) && parsed.host === String(host).toLowerCase() && parsed.port === port;
}
