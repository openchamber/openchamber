/**
 * Where a session comment on a tracker item may point. A session link is
 * written where other people read it, so only an origin they can open
 * qualifies, and the comment names only what happened: the label and the link,
 * never the conversation. Linear and every extension tracker share these rules
 * (`../linear/status.js`, `./extension-tracker.js`).
 */

const readTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 is carrier-grade NAT, which Tailscale and similar overlays use.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const address = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (address === '::1' || address === '::') return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

/**
 * A session link is only worth writing into a tracker when somebody other than the
 * person who started the session can open it. Loopback, private LAN and
 * overlay-network addresses reach nobody else, so they do not qualify.
 */
export function isPublicSessionOrigin(value) {
  const origin = readSessionOrigin(value);
  if (!origin) return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname || hostname === 'localhost') return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;
  if (hostname.includes(':') || hostname.startsWith('[')) return !isPrivateIpv6(hostname);
  if (/^[\d.]+$/.test(hostname)) return !isPrivateIpv4(hostname);
  // A bare single-label host is a LAN machine name, not a routable address.
  return hostname.includes('.');
}

export function readSessionOrigin(value) {
  const trimmed = readTrimmedString(value);
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    if (url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function buildSessionOpenUrl(sessionId, sessionOrigin) {
  const id = readTrimmedString(sessionId);
  const origin = readSessionOrigin(sessionOrigin);
  if (!origin) return '';
  return `${origin}/?session=${encodeURIComponent(id)}`;
}

function statusWord(kind) {
  if (kind === 'started') return 'started';
  if (kind === 'completed') return 'completed';
  return 'failed';
}

export function buildSessionStatusComment({ kind, sessionUrl }) {
  const url = readTrimmedString(sessionUrl);
  const label = `OpenChamber session ${statusWord(kind)}`;
  if (!url) return label;
  // The comment already lives on the issue, so it says only what happened and
  // links to the session. Issue titles routinely contain brackets ("[Bug] …"),
  // which would break this markdown link if they were repeated in the label.
  return `[${label}](${url})`;
}
