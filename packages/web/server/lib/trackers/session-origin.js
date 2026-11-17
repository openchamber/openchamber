
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
  // external: https://www.rfc-editor.org/rfc/rfc6598#section-7 100.64.0.0/10 is shared carrier-grade NAT space used by overlays.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const address = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (address === '::1' || address === '::') return true;
  // external: https://www.rfc-editor.org/rfc/rfc4193#section-3 and https://www.rfc-editor.org/rfc/rfc4291#section-2.5.6 define unique-local and link-local IPv6 ranges.
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

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
  return `[${label}](${url})`;
}
