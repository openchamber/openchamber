import crypto from 'node:crypto';

const scpRemotePattern = /^([^@/:\s]+)@([^:/\s]+):(.+)$/;
const urlPattern = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

/**
 * Whether Git reads this remote address as a path on disk: a `file://` URL, a
 * Windows drive, or Git's own rule for the rest, no colon before the first
 * slash. `C:/x` is a drive only on Windows; elsewhere Git reads it as host `C`.
 * An empty address is a failed read, not a path.
 */
export function isDiskPathRemoteUrl(url, platform = process.platform) {
  if (!url) return false;
  if (/^file:\/\//i.test(url) || /^[A-Za-z]:\\/.test(url)) return true;
  if (platform === 'win32' && /^[A-Za-z]:\//.test(url)) return true;
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon);
}

export function redactRemoteUrl(value) {
  const remote = String(value || '').trim();
  if (!remote) return '';

  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    if (remote.includes('://')) return '';
    const scpRemote = remote.match(scpRemotePattern);
    if (!scpRemote) return remote.replace(/[?#].*$/, '');
    return `${scpRemote[1]}@${scpRemote[2].toLowerCase()}:${scpRemote[3].replace(/[?#].*$/, '')}`;
  }
}

export function fingerprintRemoteUrl(value) {
  const remote = String(value || '').trim();
  let authority = remote;
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    authority = url.toString().replace(/\/$/, '');
  } catch {
    const scpRemote = remote.match(scpRemotePattern);
    if (scpRemote) authority = `${scpRemote[1]}@${scpRemote[2].toLowerCase()}:${scpRemote[3]}`;
  }
  return crypto.createHash('sha256').update(authority).digest('base64url');
}

export function redactSensitiveText(value) {
  return String(value || '')
    .replace(urlPattern, (match) => {
      let suffix = '';
      let remote = match;
      while (/[),.;\]}]$/.test(remote)) {
        suffix = remote.slice(-1) + suffix;
        remote = remote.slice(0, -1);
      }
      return `${redactRemoteUrl(remote)}${suffix}`;
    })
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1')
    .replace(/\b(authorization|private-token|oauth-token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
