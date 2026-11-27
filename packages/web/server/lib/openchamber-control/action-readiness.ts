import https from 'node:https';
import type { TerminalRead } from '../terminal/runtime.js';

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const LOOPBACK_URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{2,5})?(?:\/[^\s<>'"`]*)?)/gi;
const PREVIEW_OUTPUT_PATTERN = /(?:➜\s*(?:Local|Network):)|\b(?:local|network|loopback|serving|listening|available|ready|started|running|server|vite|webpack|next\.js|astro|sveltekit|nuxt)\b/i;
const PYTHON_HTTP_SERVER_PATTERN = /Serving HTTP on .*? port (\d{2,5})/i;
const PORTLESS_PORT_PATTERN = /^--\s+Using port (\d{2,5})\b/;
const PORTLESS_URL_PATTERN = /^\s*->\s+(https?:\/\/[^\s<>'"`]+)\s*$/;
const ANY_URL_PATTERN = /https?:\/\/[^\s<>'"`]+/gi;
const PRIVATE_IPV4_PATTERN = /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d+\.\d+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '[::1]', '[::]']);
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?']);
const CLOSERS = new Map([[')', '('], [']', '['], ['}', '{'], ['>', '<']]);

const count = (text: string, character: string) => text.split(character).length - 1;

const trimTrailingPunctuation = (url: string): string => {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1] ?? '';
    const opener = CLOSERS.get(last);
    if (opener) {
      const head = result.slice(0, -1);
      if (count(head, opener) > count(head, last)) break;
      result = head;
      continue;
    }
    if (!TRAILING_PUNCT.has(last)) break;
    result = result.slice(0, -1);
  }
  return result;
};

const normalizeLoopbackUrl = (url: string) => trimTrailingPunctuation(url)
  .replace('0.0.0.0', '127.0.0.1').replace('[::1]', '127.0.0.1').replace('[::]', '127.0.0.1');

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const loopbackPortOf = (url: string): number | null => {
  const parsed = parse(url);
  if (!parsed || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const port = Number.parseInt(parsed.port, 10);
  return Number.isFinite(port) ? port : null;
};

const isLocalNetworkHost = (hostname: string) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')
    || PRIVATE_IPV4_PATTERN.test(host) || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
};

const proxiedPortsOf = (lines: string[]) => new Set(lines
  .map((line) => Number.parseInt(PORTLESS_PORT_PATTERN.exec(line.trim())?.[1] ?? '', 10))
  .filter((port) => Number.isFinite(port) && port > 0 && port <= 65535));

const announcedUrlOf = (lines: string[], proxied: Set<number>): string | null => {
  const usable = (url: string) => {
    const port = loopbackPortOf(url);
    return isLocalNetworkHost(parse(url)?.hostname ?? '') && (port === null || !proxied.has(port));
  };
  const candidates: string[] = [];
  const pythonPort = Number.parseInt(PYTHON_HTTP_SERVER_PATTERN.exec(lines.join('\n'))?.[1] ?? '', 10);
  if (Number.isFinite(pythonPort) && pythonPort > 0 && pythonPort <= 65535) candidates.push(`http://127.0.0.1:${pythonPort}/`);
  for (const line of lines) {
    const portless = PORTLESS_URL_PATTERN.exec(line)?.[1];
    if (portless) {
      candidates.push(trimTrailingPunctuation(portless));
      continue;
    }
    if (!PREVIEW_OUTPUT_PATTERN.test(line)) continue;
    const matches = Array.from(line.matchAll(LOOPBACK_URL_PATTERN), (match) => normalizeLoopbackUrl(match[1] ?? ''));
    const chosen = matches.find((url) => Boolean(parse(url)?.port)) ?? matches[0];
    if (chosen) candidates.push(chosen);
  }
  return candidates.find(usable) ?? null;
};

export const extractRunUrl = (output: string): string | null => {
  const lines = output.replace(ANSI_ESCAPE_PATTERN, '').split('\n');
  const proxied = proxiedPortsOf(lines);
  const announced = announcedUrlOf(lines, proxied);
  if (announced) return announced;

  const candidates = (lines.join('\n').match(ANY_URL_PATTERN) ?? [])
    .map((raw) => parse(trimTrailingPunctuation(raw)))
    .filter((parsed): parsed is URL => parsed !== null && isLocalNetworkHost(parsed.hostname) && Boolean(parsed.port))
    .filter((parsed) => !proxied.has(loopbackPortOf(parsed.toString()) ?? -1));
  const score = (parsed: URL) => {
    const host = parsed.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    return (loopback ? 50 : 0) - (parsed.search || parsed.hash ? 10 : 0);
  };
  const best = candidates.reduce<URL | null>((current, candidate) => (!current || score(candidate) > score(current) ? candidate : current), null);
  return best ? normalizeLoopbackUrl(best.toString()) : null;
};

const isStartingAnswer = (url: string, status: number) => {
  const host = parse(url)?.hostname.toLowerCase() ?? '';
  const local = LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  return local && (status === 404 || status >= 500);
};

export type ProbeUrl = (url: string, signal: AbortSignal | undefined) => Promise<number | null>;

const MAX_REDIRECTS = 3;
const UNTRUSTED_CA_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type ProbeAnswer = { status: number; location: string | null };

const requestLoopbackHttps = (target: URL, signal: AbortSignal) => new Promise<ProbeAnswer>((resolve, reject) => {
  const request = https.get(target, { rejectUnauthorized: false, signal }, (response) => {
    response.resume();
    resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null });
  });
  request.once('error', reject);
});

const requestOnce = async (target: URL, signal: AbortSignal): Promise<ProbeAnswer> => {
  if (target.protocol === 'https:' && UNTRUSTED_CA_HOSTS.has(target.hostname.toLowerCase())) return requestLoopbackHttps(target, signal);
  const response = await fetch(target, { method: 'GET', redirect: 'manual', signal });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, location: response.headers.get('location') };
};

export const probeUrl: ProbeUrl = async (url, signal) => {
  const timeout = AbortSignal.timeout(2_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    let target = new URL(url);
    for (let hop = 0; ; hop += 1) {
      const { status, location } = await requestOnce(target, combined);
      const next = status >= 300 && status < 400 && location ? new URL(location, target) : null;
      if (!next || next.origin !== target.origin || hop >= MAX_REDIRECTS) return status;
      target = next;
    }
  } catch {
    return null;
  }
};

export const configuredAddress = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const protocol = parse(address)?.protocol;
  return protocol === 'http:' || protocol === 'https:' ? address : null;
};

export type RunReadiness =
  | { state: 'ready'; url: string; httpStatus: number }
  | { state: 'exited'; url: string | null; httpStatus: number | null; exitCode: number | null }
  | { state: 'starting'; url: string | null; httpStatus: number | null }
  | { state: 'no-address' };

export interface ReadinessWait {
  readTerminal: (sessionId: string, options?: { maxBytes?: number }) => TerminalRead | null;
  probe: ProbeUrl;
  limitMs: number;
  pollMs: number;
}

const pause = (ms: number, signal: AbortSignal | undefined) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

export const waitForRun = async (
  { readTerminal, probe, limitMs, pollMs }: ReadinessWait,
  terminalId: string,
  { url: configuredUrl, waitForExit, signal }: { url: string | null; waitForExit: boolean; signal: AbortSignal | undefined },
): Promise<RunReadiness | null> => {
  const deadline = Date.now() + limitMs;
  const configured = configuredAddress(configuredUrl);
  let url = configured;
  let httpStatus: number | null = null;
  const failed = () => {
    const run = readTerminal(terminalId, { maxBytes: 1 });
    return !run || (run.status !== 'running' && run.exitCode !== 0);
  };
  for (;;) {
    if (signal?.aborted) return null;
    const run = readTerminal(terminalId, { maxBytes: 262_144 });
    const inferred = !configured && run ? extractRunUrl(run.text) : null;
    if (inferred && inferred !== url) {
      url = inferred;
      httpStatus = null;
    }
    const exitCode = run?.exitCode ?? null;
    const ended = !run || run.status !== 'running';
    if (ended && (!url || exitCode !== 0)) return { state: 'exited', url, httpStatus, exitCode };
    if (url) {
      const status = await probe(url, signal);
      if (signal?.aborted) return null;
      if (status !== null) {
        httpStatus = status;
        if (!isStartingAnswer(url, status) && !failed()) return { state: 'ready', url, httpStatus: status };
      }
    } else if (!waitForExit) {
      return { state: 'no-address' };
    }
    if (Date.now() >= deadline) return ended ? { state: 'exited', url, httpStatus, exitCode } : { state: 'starting', url, httpStatus };
    await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
};
