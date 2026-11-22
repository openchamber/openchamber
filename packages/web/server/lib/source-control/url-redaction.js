import crypto from 'node:crypto';

const scpRemotePattern = /^([^@/:\s]+)@([^:/\s]+):(.+)$/;
const urlPattern = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

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

// The sensitive assignment keys, converged with the git redactor
// (lib/git/redaction.js): the same key/value and header shapes must not
// survive on one surface while the other strips them (#1920). The scheme
// pattern runs first so 'authorization: Bearer <value>' loses the value,
// not just the scheme word.
const sensitiveKeyPattern = 'x-api-key|access[-_]token|api[-_]key|client[-_]secret|oauth[-_]token|private[-_]token|authorization|password|secret|token';

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
    .replace(/\b(authorization\s*:\s*(?:bearer|basic))\s+[^\s,;]+/gi, '$1 [redacted]')
    // #2074/#2128: quoted values (JSON/Python-dumped headers/config) — the quote between
    // key and colon defeated both neighbours, and a quoted value must keep
    // its quotes: redact only the credential inside them, preserving the
    // key, separator, scheme word, and JSON structure.
    .replace(new RegExp(`\\b(${sensitiveKeyPattern})(["']?\\s*[:=]\\s*["'])((?:bearer|basic)\\s+)?[^\\s"',;]+`, 'gi'), '$1$2$3[redacted]')
    // #2074: scheme-headed assignment values for any sensitive key
    // (authorization=Bearer <t>, api_key: Bearer <t>) — the plain assignment
    // pattern below refuses bearer/basic-headed values to protect the
    // scheme word, so redact the credential after it explicitly.
    .replace(new RegExp(`\\b(${sensitiveKeyPattern})(\\s*[:=]\\s*(?:bearer|basic))\\s+[^\\s,;]+`, 'gi'), '$1$2 [redacted]')
    .replace(new RegExp(`\\b(${sensitiveKeyPattern})\\s*[:=]\\s*(?!(?:bearer|basic)\\s)[^\\s"',;]+`, 'gi'), '$1=[redacted]');
}
