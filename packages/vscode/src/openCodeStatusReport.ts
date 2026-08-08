import type { OpenCodeManager } from './opencode';

export type OpenCodeStatusProbeResult = {
  ok: boolean;
  status: number;
  elapsedMs: number;
  summary: string;
};

export type OpenCodeStatusReportInput = {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  workspaceFolders: string[];
  configuredApiUrl: string;
  configuredBinary: string;
  settingsKeys: string[];
  manager?: OpenCodeManager;
  now?: number;
  fetchImpl?: typeof fetch;
};

const formatIso = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
};

const formatDurationMs = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(none)';
  const seconds = Math.round(value / 100) / 10;
  return `${seconds}s`;
};

const safeFetch = async (
  input: string,
  openCodeAuthHeaders: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<OpenCodeStatusProbeResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const resp = await fetchImpl(input, {
      method: 'GET',
      headers: { Accept: 'application/json', ...openCodeAuthHeaders },
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
      controller.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
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

const PROBE_TARGETS: Array<{ label: string; path: string; includeDirectory?: boolean; timeoutMs?: number }> = [
  { label: 'health', path: '/global/health', includeDirectory: false },
  { label: 'config', path: '/config', includeDirectory: true },
  { label: 'providers', path: '/config/providers', includeDirectory: true },
  { label: 'agents', path: '/agent', includeDirectory: true, timeoutMs: 12000 },
  { label: 'commands', path: '/command', includeDirectory: true, timeoutMs: 10000 },
  { label: 'project', path: '/project/current', includeDirectory: true },
  { label: 'path', path: '/path', includeDirectory: true },
  { label: 'sessions', path: '/session', includeDirectory: true, timeoutMs: 12000 },
  { label: 'sessionStatus', path: '/session/status', includeDirectory: true },
];

export async function buildOpenCodeStatusReport(input: OpenCodeStatusReportInput): Promise<string> {
  const now = input.now ?? Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const manager = input.manager;
  const debug = manager?.getDebugInfo();
  const resolvedApiUrl = manager?.getApiUrl();
  const workingDirectory = manager?.getWorkingDirectory() ?? '';
  const primaryWorkspace = input.workspaceFolders[0] || '';
  const workingDirectoryMatchesWorkspace = Boolean(primaryWorkspace && workingDirectory === primaryWorkspace);

  let resolvedApiPath = '';
  if (resolvedApiUrl) {
    try {
      resolvedApiPath = new URL(resolvedApiUrl).pathname || '/';
    } catch {
      resolvedApiPath = '(invalid url)';
    }
  }

  const buildProbeUrl = (pathname: string, includeDirectory = true) => {
    if (!resolvedApiUrl) return null;
    const base = `${resolvedApiUrl.replace(/\/+$/, '')}/`;
    const url = new URL(pathname.replace(/^\/+/, ''), base);
    if (includeDirectory && workingDirectory) {
      url.searchParams.set('directory', workingDirectory);
    }
    return url.toString();
  };

  const openCodeAuthHeaders = manager?.getOpenCodeAuthHeaders() || {};
  const probes = resolvedApiUrl
    ? await Promise.all(
        PROBE_TARGETS.map(async (entry) => {
          const url = buildProbeUrl(entry.path, entry.includeDirectory !== false);
          if (!url) {
            return { label: entry.label, url: '(none)', result: null as OpenCodeStatusProbeResult | null };
          }
          const result = await safeFetch(
            url,
            openCodeAuthHeaders,
            typeof entry.timeoutMs === 'number' ? entry.timeoutMs : 6000,
            fetchImpl,
          );
          return { label: entry.label, url, result };
        }),
      )
    : [];

  const lines = [
    `Time: ${new Date(now).toISOString()}`,
    `OpenChamber version: ${input.extensionVersion || '(unknown)'}`,
    `OpenCode Version: ${debug?.version ?? '(unknown)'}`,
    `VS Code version: ${input.vscodeVersion}`,
    `Platform: ${input.platform} ${input.arch}`,
    `Workspace folders: ${input.workspaceFolders.length}${input.workspaceFolders.length ? ` (${input.workspaceFolders.join(', ')})` : ''}`,
    `Status: ${manager?.getStatus() ?? 'unknown'}`,
    `Working directory: ${workingDirectory}`,
    `Working dir matches workspace: ${workingDirectoryMatchesWorkspace ? 'yes' : 'no'}`,
    `API URL (configured): ${input.configuredApiUrl || '(none)'}`,
    `OpenCode binary (configured): ${input.configuredBinary || '(none)'}`,
    `API URL (resolved): ${manager?.getApiUrl() ?? '(none)'}`,
    `API URL path: ${resolvedApiPath || '(none)'}`,
    debug ? `OpenCode server URL: ${debug.serverUrl ?? '(none)'}` : `OpenCode server URL: (unknown)`,
    debug
      ? `OpenCode mode: ${debug.mode} (starts=${debug.startCount}, restarts=${debug.restartCount})`
      : `OpenCode mode: (unknown)`,
    debug
      ? `Secure OpenCode connection: ${debug.secureConnection ? 'true' : 'false'}`
      : `Secure OpenCode connection: (unknown)`,
    debug ? `OpenCode auth source: ${debug.authSource ?? '(none)'}` : `OpenCode auth source: (unknown)`,
    debug ? `OpenCode CLI path: ${debug.cliPath || '(not found)'}` : `OpenCode CLI path: (unknown)`,
    debug ? `OpenCode detected port: ${debug.detectedPort ?? '(none)'}` : `OpenCode detected port: (unknown)`,
    debug
      ? `OpenCode API prefix: ${debug.apiPrefixDetected ? (debug.apiPrefix || '(root)') : '(unknown)'}`
      : `OpenCode API prefix: (unknown)`,
    debug ? `Last start: ${formatIso(debug.lastStartAt)}` : `Last start: (unknown)`,
    debug
      ? `Last ready: ${debug.lastReadyElapsedMs !== null ? `${debug.lastReadyElapsedMs}ms` : '(unknown)'}`
      : `Last ready: (unknown)`,
    debug ? `Ready attempts: ${debug.lastReadyAttempts ?? '(unknown)'}` : `Ready attempts: (unknown)`,
    debug ? `Start attempts: ${debug.lastStartAttempts ?? '(unknown)'}` : `Start attempts: (unknown)`,
    debug ? `Last connected: ${formatIso(debug.lastConnectedAt)}` : `Last connected: (unknown)`,
    debug && debug.lastConnectedAt
      ? `Connected for: ${formatDurationMs(now - debug.lastConnectedAt)}`
      : `Connected for: (n/a)`,
    debug && debug.lastExitCode !== null ? `Last exit code: ${debug.lastExitCode}` : `Last exit code: (none)`,
    debug?.lastError ? `Last error: ${debug.lastError}` : `Last error: (none)`,
    `Settings keys (stored): ${input.settingsKeys.length ? input.settingsKeys.join(', ') : '(none)'}`,
    probes.length ? '' : '',
    ...(probes.length
      ? [
          'OpenCode API probes:',
          ...probes.map((probe) => {
            if (!probe.result) return `- ${probe.label}: (no url)`;
            const { ok, status, elapsedMs, summary } = probe.result;
            const suffix = ok ? '' : ` url=${probe.url}`;
            return `- ${probe.label}: ${ok ? 'ok' : 'fail'} status=${status} time=${elapsedMs}ms ${summary}${suffix}`;
          }),
        ]
      : []),
    '',
  ];

  return lines.join('\n');
}
