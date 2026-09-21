import { runtimeFetch } from '@/lib/runtime-fetch';

const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const LOOPBACK_URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{2,5})?(?:\/[^\s<>'"`]*)?)/gi;
const PREVIEW_OUTPUT_PATTERN = /(?:➜\s*(?:Local|Network):)|\b(?:local|network|loopback|serving|listening|available|ready|started|running|server|vite|webpack|next\.js|astro|sveltekit|nuxt)\b/i;
const PYTHON_HTTP_SERVER_PATTERN = /Serving HTTP on .*? port (\d{2,5})/i;
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
export const extractAnnouncedUrls = (text: string): string[] => {
  if (!text) return [];

  const cleaned = text.replace(ANSI_ESCAPE_PATTERN, '');
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (url: string) => {
    if (seen.has(url)) return;
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

export const extractTerminalPreviewUrl = (text: string): string | null => (
  extractAnnouncedUrls(text)[0] ?? null
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

  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1' && host !== '::') {
    return false;
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
  { requireAnnounced = false }: { requireAnnounced?: boolean } = {},
): string | null => {
  const announced = extractTerminalPreviewUrl(text);
  if (announced) return announced;
  if (requireAnnounced) return null;

  const cleaned = String(text || '').replace(ANSI_ESCAPE_PATTERN, '');
  const candidates: URL[] = [];
  for (const raw of cleaned.match(ANY_URL_PATTERN) ?? []) {
    try {
      const parsed = new URL(trimUrlTrailingPunctuation(raw));
      if (parsed.port) candidates.push(parsed);
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
