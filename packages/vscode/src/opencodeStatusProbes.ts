import { OPENCODE_TRUST_REQUIRED } from '../../web/server/lib/opencode-trust/index.js';
import { openCodeTrust, type OpenCodeTrustGuard } from './opencodeTrust';

interface OpenCodeStatusProbeResult {
  ok: boolean;
  status: number;
  elapsedMs: number;
  summary: string;
  skipped?: boolean;
}

interface OpenCodeStatusProbe {
  label: string;
  url: string;
  result: OpenCodeStatusProbeResult | null;
}

type OpenCodeStatusProbeScope = 'global' | 'location' | 'sessionFilter';

interface OpenCodeStatusProbeTarget {
  label: string;
  path: string;
  scope: OpenCodeStatusProbeScope;
  timeoutMs?: number;
}

const PROBE_TARGETS: ReadonlyArray<OpenCodeStatusProbeTarget> = [
  { label: 'health', path: '/api/info', scope: 'global' },
  { label: 'config', path: '/api/config', scope: 'location' },
  { label: 'providers', path: '/api/provider', scope: 'location' },
  { label: 'agents', path: '/api/agent', scope: 'location', timeoutMs: 12000 },
  { label: 'commands', path: '/api/command', scope: 'location', timeoutMs: 10000 },
  { label: 'project', path: '/api/project', scope: 'global' },
  { label: 'location', path: '/api/location', scope: 'location' },
  { label: 'sessions', path: '/api/session', scope: 'sessionFilter', timeoutMs: 12000 },
  { label: 'sessionStatus', path: '/api/session/active', scope: 'global' },
];

const buildProbeUrl = (resolvedApiUrl: string, pathname: string, sessionFilterDirectory: string): URL => {
  const base = `${resolvedApiUrl.replace(/\/+$/, '')}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  if (sessionFilterDirectory) {
    url.searchParams.set('directory', sessionFilterDirectory);
  }
  return url;
};

const skippedProbe = (label: string, url: URL, status: number, summary: string): OpenCodeStatusProbe => ({
  label,
  url: url.toString(),
  result: { ok: false, status, elapsedMs: 0, summary, skipped: true },
});

const safeFetchProbe = async (
  fetchImpl: typeof fetch,
  input: string,
  headers: Record<string, string>,
  timeoutMs = 6000,
): Promise<OpenCodeStatusProbeResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const resp = await fetchImpl(input, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.toLowerCase().includes('json') && !contentType.toLowerCase().includes('text/html');

    let summary = '';
    if (isJson) {
      const json = await resp.json().catch(() => null);
      if (Array.isArray(json)) {
        summary = `json[array] len=${json.length}`;
      } else if (json && typeof json === 'object') {
        const keys = Object.keys(json).slice(0, 8);
        summary = `json[object] keys=${keys.join(',')}${Object.keys(json).length > keys.length ? ',…' : ''}`;
      } else {
        summary = `json[${typeof json}]`;
      }
    } else {
      summary = contentType ? `content-type=${contentType}` : 'no content-type';
    }

    return { ok: resp.ok && isJson, status: resp.status, elapsedMs, summary };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort =
      controller.signal.aborted
      || (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
    const message = isAbort
      ? `timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, status: 0, elapsedMs, summary: `error=${message}` };
  } finally {
    clearTimeout(timeout);
  }
};

export const runOpenCodeStatusProbes = async ({
  resolvedApiUrl,
  workingDirectory,
  authHeaders = {},
  trust = openCodeTrust,
  fetchImpl = fetch,
}: {
  resolvedApiUrl: string | null | undefined;
  workingDirectory: string;
  authHeaders?: Record<string, string>;
  trust?: OpenCodeTrustGuard;
  fetchImpl?: typeof fetch;
}): Promise<OpenCodeStatusProbe[]> => {
  if (!resolvedApiUrl) return [];
  const baseHeaders = { Accept: 'application/json', ...authHeaders };
  const locationHeaders = workingDirectory
    ? {
      ...baseHeaders,
      'x-opencode-directory': encodeURIComponent(workingDirectory),
      'x-opencode-directory-encoding': 'uri',
    }
    : null;
  return Promise.all(
    PROBE_TARGETS.map(async (entry) => {
      const url = buildProbeUrl(resolvedApiUrl, entry.path, entry.scope === 'sessionFilter' ? workingDirectory : '');
      if (entry.scope === 'location' && !locationHeaders) {
        return skippedProbe(entry.label, url, 0, 'no workspace folder');
      }
      const headers = entry.scope === 'location' && locationHeaders ? locationHeaders : baseHeaders;
      const refusal = await trust.refusalFor({
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers,
      });
      if (refusal) {
        const reason = 'error' in refusal.body && refusal.body.code !== OPENCODE_TRUST_REQUIRED
          ? refusal.body.error
          : 'folder trust required';
        return skippedProbe(entry.label, url, refusal.status, reason);
      }
      const result = await safeFetchProbe(fetchImpl, url.toString(), headers, entry.timeoutMs ?? 6000);
      return { label: entry.label, url: url.toString(), result };
    }),
  );
};

export const formatOpenCodeStatusProbes = (probes: ReadonlyArray<OpenCodeStatusProbe>): string[] => {
  if (probes.length === 0) return [];
  return [
    'OpenCode API probes:',
    ...probes.map((probe) => {
      if (!probe.result) return `- ${probe.label}: (no url)`;
      const { ok, status, elapsedMs, summary, skipped } = probe.result;
      if (skipped) return `- ${probe.label}: skipped status=${status} ${summary}`;
      const suffix = ok ? '' : ` url=${probe.url}`;
      return `- ${probe.label}: ${ok ? 'ok' : 'fail'} status=${status} time=${elapsedMs}ms ${summary}${suffix}`;
    }),
  ];
};
