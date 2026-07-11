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

export const extractTerminalPreviewUrl = (text: string): string | null => {
  if (!text) return null;

  const cleaned = text.replace(ANSI_ESCAPE_PATTERN, '');
  const pythonMatch = cleaned.match(PYTHON_HTTP_SERVER_PATTERN);
  if (pythonMatch?.[1]) {
    const port = Number.parseInt(pythonMatch[1], 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return `http://127.0.0.1:${port}/`;
    }
  }

  const lines = cleaned.split('\n');
  for (const line of lines) {
    if (!PREVIEW_OUTPUT_PATTERN.test(line)) {
      continue;
    }

    const matches = Array.from(line.matchAll(LOOPBACK_URL_PATTERN));
    if (matches.length === 0) {
      continue;
    }

    const withPort = matches.find((match) => {
      try {
        return Boolean(new URL(normalizeLoopbackUrl(match[1])).port);
      } catch {
        return false;
      }
    });
    return normalizeLoopbackUrl((withPort ?? matches[0])[1]);
  }

  return null;
};

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
