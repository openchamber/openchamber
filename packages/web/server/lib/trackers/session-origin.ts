
const isSessionText = (value: unknown): value is string => typeof value === 'string';
const readTrimmedString = (value: Parameters<typeof isSessionText>[0]) => (isSessionText(value) ? value.trim() : '');

const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a = -1, b = -1] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname: string) {
  const address = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (address === '::1' || address === '::') return true;
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

export function isPublicSessionOrigin(value: string | null | undefined) {
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

export function readSessionOrigin(value: Parameters<typeof isSessionText>[0]) {
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

export function buildSessionOpenUrl(sessionId: string | null | undefined, sessionOrigin: string | null | undefined) {
  const id = readTrimmedString(sessionId);
  const origin = readSessionOrigin(sessionOrigin);
  if (!origin) return '';
  return `${origin}/?session=${encodeURIComponent(id)}`;
}

function statusWord(kind: string) {
  if (kind === 'started') return 'started';
  if (kind === 'completed') return 'completed';
  return 'failed';
}

export function buildSessionStatusComment({ kind, sessionUrl }: { kind: string; sessionUrl?: string | null }) {
  const url = readTrimmedString(sessionUrl);
  const label = `OpenChamber session ${statusWord(kind)}`;
  if (!url) return label;
  return `[${label}](${url})`;
}
