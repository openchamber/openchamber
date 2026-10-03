import { runtimeFetch } from '@/lib/runtime-fetch';

const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const LOOPBACK_URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{2,5})?(?:\/[^\s<>'"`]*)?)/gi;
const PREVIEW_OUTPUT_PATTERN = /(?:➜\s*(?:Local|Network):)|\b(?:local|network|loopback|serving|listening|available|ready|started|running|server|vite|webpack|next\.js|astro|sveltekit|nuxt)\b/i;
const PYTHON_HTTP_SERVER_PATTERN = /Serving HTTP on .*? port (\d{2,5})/i;
// portless (vercel-labs/portless) puts a dev server behind a named address:
// it prints "-- Using port 4123" for the port it hands the server, then the
// address itself as "  -> https://auth.myapp.localhost". The server then
// announces its own loopback port, which is the same app without the name.
const PORTLESS_PORT_PATTERN = /^--\s+Using port (\d{2,5})\b/;
const PORTLESS_URL_PATTERN = /^\s*->\s+(https?:\/\/[^\s<>'"`]+)\s*$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '[::1]', '[::]']);
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?']);

const trimUrlTrailingPunctuation = (url: string): string => {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last === ')' || last === ']' || last === '}' || last === '>') {
      const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '<';
      const head = result.slice(0, -1);
      const opens = (head.match(new RegExp(`\\${opener}`, 'g')) || []).length;
      const closes = (head.match(new RegExp(`\\${last}`, 'g')) || []).length;
      if (opens > closes) break;
      result = head;
      continue;
    }
    if (TRAILING_PUNCT.has(last)) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
};

const normalizeLoopbackUrl = (url: string): string => {
  let normalized = trimUrlTrailingPunctuation(url);
  normalized = normalized.replace('0.0.0.0', '127.0.0.1');
  normalized = normalized.replace('[::1]', '127.0.0.1');
  normalized = normalized.replace('[::]', '127.0.0.1');
  return normalized;
};

/**
 * Every address a server announced in this output, in the order announced.
 *
 * A project can start several servers at once — a gateway and the apps behind
 * it, an API alongside a site — and each announces itself. Taking the first is
 * a coin toss decided by which chunk the terminal emitted first, so callers
 * that must choose are given all of them instead.
 */
const portOf = (url: string): number | null => {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
};

/** True for an address on this machine's loopback interface by number or `localhost`. */
export const isLoopbackPreviewUrl = (url: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * Loopback ports portless announced it put behind a named address. Output is
 * scanned in chunks, so callers keep what earlier chunks reported and pass it
 * back to `extractAnnouncedUrls`.
 */
export const extractProxiedPorts = (text: string): number[] => {
  const ports: number[] = [];
  for (const line of text.replace(ANSI_ESCAPE_PATTERN, '').split('\n')) {
    const port = Number.parseInt(PORTLESS_PORT_PATTERN.exec(line.trim())?.[1] ?? '', 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
};

export type AnnouncementOptions = {
  /** Ports earlier output said portless put behind a name. */
  readonly proxiedPorts?: readonly number[];
  /**
   * False when a named local address resolves on the wrong machine (a desktop
   * viewing a remote instance, which tunnels loopback ports only): portless
   * names are then skipped and the port behind them is the address.
   */
  readonly namedAddressesReachable?: boolean;
};

export const extractAnnouncedUrls = (
  text: string,
  { proxiedPorts = [], namedAddressesReachable = true }: AnnouncementOptions = {},
): string[] => {
  if (!text) return [];

  const cleaned = text.replace(ANSI_ESCAPE_PATTERN, '');
  const proxied = new Set(namedAddressesReachable ? [...proxiedPorts, ...extractProxiedPorts(cleaned)] : []);
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (url: string) => {
    if (seen.has(url)) return;
    // The server behind a portless name, reached around it: the named
    // address is the one to open.
    const port = portOf(url);
    if (port !== null && proxied.has(port)) return;
    seen.add(url);
    found.push(url);
  };

  const pythonMatch = cleaned.match(PYTHON_HTTP_SERVER_PATTERN);
  if (pythonMatch?.[1]) {
    const port = Number.parseInt(pythonMatch[1], 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      add(`http://127.0.0.1:${port}/`);
    }
  }

  for (const line of cleaned.split('\n')) {
    const portlessUrl = PORTLESS_URL_PATTERN.exec(line)?.[1];
    if (portlessUrl) {
      if (namedAddressesReachable) add(trimUrlTrailingPunctuation(portlessUrl));
      continue;
    }
    if (!PREVIEW_OUTPUT_PATTERN.test(line)) continue;

    const matches = Array.from(line.matchAll(LOOPBACK_URL_PATTERN));
    if (matches.length === 0) continue;

    const withPort = matches.find((match) => {
      try {
        return Boolean(new URL(normalizeLoopbackUrl(match[1])).port);
      } catch {
        return false;
      }
    });
    add(normalizeLoopbackUrl((withPort ?? matches[0])[1]));
  }

  return found;
};

export const extractTerminalPreviewUrl = (text: string, options: AnnouncementOptions = {}): string | null => (
  extractAnnouncedUrls(text, options)[0] ?? null
);

export const isTerminalPreviewUrlAvailable = async (url: string, timeoutMs = 1500): Promise<boolean> => {
  if (!url) return false;
  if (typeof window === 'undefined') return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Only portless announces a named address here, and it does so once the
  // route is registered. The server's probe stays loopback-only (a name can
  // resolve anywhere), so a named address is taken as announced.
  if (!isLoopbackPreviewUrl(parsed.toString())) {
    return true;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await runtimeFetch('/api/system/probe-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.toString() }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }

    const result = await response.json().catch(() => null) as { ok?: unknown } | null;
    return result?.ok === true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
};

const ANY_URL_PATTERN = /https?:\/\/[^\s<>'"`]+/gi;
const PRIVATE_IPV4_PATTERN = /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d+\.\d+$/;

// A URL nobody announced is only a guess, and it opens in the system browser
// by itself. The guess stays on this machine or the local network: an address
// that merely appears in output (a docs link, a log line a dependency prints)
// is never opened.
const isLocalNetworkHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || PRIVATE_IPV4_PATTERN.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || host.startsWith('fe80:');
};

/**
 * Finds the URL a project action wants opened.
 *
 * Prefers the announcement line — `Local`, `ready on`, `serving` — because that
 * is the address the server is telling you to visit. The path is part of that
 * answer: an app served under a base path announces it, and dropping it lands
 * the user on that app's own 404.
 *
 * `requireAnnounced` refuses to guess at all. Output is scanned in whatever
 * chunks the terminal emits and the first match wins, so scoring loose URLs
 * makes the result depend on where those chunk boundaries happened to fall — a
 * dev gateway logging its routing table offers several backends that all look
 * openable. Where the command itself was inferred rather than configured,
 * waiting for a server to announce itself is the only answer that is the same
 * every time.
 */
export const extractProjectActionUrl = (
  text: string,
  { requireAnnounced = false, ...announcement }: AnnouncementOptions & { requireAnnounced?: boolean } = {},
): string | null => {
  const announced = extractTerminalPreviewUrl(text, announcement);
  const proxiedPorts = announcement.namedAddressesReachable === false ? [] : (announcement.proxiedPorts ?? []);
  if (announced) return announced;
  if (requireAnnounced) return null;

  const cleaned = String(text || '').replace(ANSI_ESCAPE_PATTERN, '');
  const candidates: URL[] = [];
  for (const raw of cleaned.match(ANY_URL_PATTERN) ?? []) {
    try {
      const parsed = new URL(trimUrlTrailingPunctuation(raw));
      const loopbackPort = portOf(parsed.toString());
      if (!isLocalNetworkHost(parsed.hostname)) continue;
      if (parsed.port && !(loopbackPort !== null && proxiedPorts.includes(loopbackPort))) candidates.push(parsed);
    } catch {
      // Not a URL after trimming; nothing to score.
    }
  }
  if (candidates.length === 0) return null;

  const score = (parsed: URL): number => {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    // Only the host is scored. Path depth used to count against a candidate,
    // which is backwards: a printed path is information the server gave us.
    return (isLoopback ? 50 : 0) - (parsed.search || parsed.hash ? 10 : 0);
  };

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (score(candidate) > score(best)) best = candidate;
  }
  return normalizeLoopbackUrl(best.toString());
};
