import * as vscode from 'vscode';
import type { OpenCodeManager } from '../opencode';

const SETTINGS_KEY = 'openchamber.settings';

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

export type ShowOpenCodeStatusDeps = {
  openCodeManager?: OpenCodeManager;
  outputChannel?: vscode.OutputChannel;
};

export const registerShowOpenCodeStatusCommand = (
  context: vscode.ExtensionContext,
  deps: ShowOpenCodeStatusDeps,
): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand('openchamber.showOpenCodeStatus', async () => {
      const config = vscode.workspace.getConfiguration('openchamber');
      const configuredApiUrl = (config.get<string>('apiUrl') || '').trim();

      const extensionVersion = String(context.extension?.packageJSON?.version || '');
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const primaryWorkspace = workspaceFolders[0] || '';

      const openCodeManager = deps.openCodeManager;
      const debug = openCodeManager?.getDebugInfo();
      const resolvedApiUrl = openCodeManager?.getApiUrl();
      const workingDirectory = openCodeManager?.getWorkingDirectory() ?? '';
      const workingDirectoryMatchesWorkspace = Boolean(primaryWorkspace && workingDirectory === primaryWorkspace);
      let resolvedApiPath = '';
      if (resolvedApiUrl) {
        try {
          resolvedApiPath = new URL(resolvedApiUrl).pathname || '/';
        } catch {
          resolvedApiPath = '(invalid url)';
        }
      }

      const safeFetch = async (input: string, timeoutMs = 6000) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        const openCodeAuthHeaders = openCodeManager?.getOpenCodeAuthHeaders() || {};
        try {
          const resp = await fetch(input, {
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

      const buildProbeUrl = (pathname: string, includeDirectory = true) => {
        if (!resolvedApiUrl) return null;
        const base = `${resolvedApiUrl.replace(/\/+$/, '')}/`;
        const url = new URL(pathname.replace(/^\/+/, ''), base);
        if (includeDirectory && workingDirectory) {
          url.searchParams.set('directory', workingDirectory);
        }
        return url.toString();
      };

      const probeTargets: Array<{ label: string; path: string; includeDirectory?: boolean; timeoutMs?: number }> = [
        { label: 'health', path: '/global/health', includeDirectory: false },
        { label: 'config', path: '/config', includeDirectory: true },
        { label: 'providers', path: '/config/providers', includeDirectory: true },
        // Can be slower on large configs; keep the probe from producing false negatives.
        { label: 'agents', path: '/agent', includeDirectory: true, timeoutMs: 12000 },
        { label: 'commands', path: '/command', includeDirectory: true, timeoutMs: 10000 },
        { label: 'project', path: '/project/current', includeDirectory: true },
        { label: 'path', path: '/path', includeDirectory: true },
        // Session listing is what powers the sidebar. This helps diagnose "no sessions shown" bugs.
        { label: 'sessions', path: '/session', includeDirectory: true, timeoutMs: 12000 },
        { label: 'sessionStatus', path: '/session/status', includeDirectory: true },
      ];

      const probes = resolvedApiUrl
        ? await Promise.all(
            probeTargets.map(async (entry) => {
              const url = buildProbeUrl(entry.path, entry.includeDirectory !== false);
              if (!url) {
                return { label: entry.label, url: '(none)', result: null as null };
              }
              const result = await safeFetch(url, typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined);
              return { label: entry.label, url, result };
            }),
          )
        : [];

      const storedSettings = context.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
      const settingsKeys = Object.keys(storedSettings).filter((key) => key !== 'lastDirectory');

      const lines = [
        `Time: ${new Date().toISOString()}`,
        `OpenChamber version: ${extensionVersion || '(unknown)'}`,
        `OpenCode Version: ${debug?.version ?? '(unknown)'}`,
        `VS Code version: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Workspace folders: ${workspaceFolders.length}${workspaceFolders.length ? ` (${workspaceFolders.join(', ')})` : ''}`,
        `Status: ${openCodeManager?.getStatus() ?? 'unknown'}`,
        `Working directory: ${workingDirectory}`,
        `Working dir matches workspace: ${workingDirectoryMatchesWorkspace ? 'yes' : 'no'}`,
        `API URL (configured): ${configuredApiUrl || '(none)'}`,
        `OpenCode binary (configured): ${(vscode.workspace.getConfiguration('openchamber').get<string>('opencodeBinary') || '').trim() || '(none)'}`,
        `API URL (resolved): ${openCodeManager?.getApiUrl() ?? '(none)'}`,
        `API URL path: ${resolvedApiPath || '(none)'}`,
        debug
          ? `OpenCode server URL: ${debug.serverUrl ?? '(none)'}`
          : `OpenCode server URL: (unknown)`,
        debug
          ? `OpenCode mode: ${debug.mode} (starts=${debug.startCount}, restarts=${debug.restartCount})`
          : `OpenCode mode: (unknown)`,
        debug
          ? `Secure OpenCode connection: ${debug.secureConnection ? 'true' : 'false'}`
          : `Secure OpenCode connection: (unknown)`,
        debug
          ? `OpenCode auth source: ${debug.authSource ?? '(none)'}`
          : `OpenCode auth source: (unknown)`,
        debug
          ? `OpenCode CLI path: ${debug.cliPath || '(not found)'}`
          : `OpenCode CLI path: (unknown)`,
        debug
          ? `OpenCode detected port: ${debug.detectedPort ?? '(none)'}`
          : `OpenCode detected port: (unknown)`,
        debug
          ? `OpenCode API prefix: ${debug.apiPrefixDetected ? (debug.apiPrefix || '(root)') : '(unknown)'}`
          : `OpenCode API prefix: (unknown)`,
        debug
          ? `Last start: ${formatIso(debug.lastStartAt)}`
          : `Last start: (unknown)`,
        debug
          ? `Last ready: ${debug.lastReadyElapsedMs !== null ? `${debug.lastReadyElapsedMs}ms` : '(unknown)'}`
          : `Last ready: (unknown)`,
        debug
          ? `Ready attempts: ${debug.lastReadyAttempts ?? '(unknown)'}`
          : `Ready attempts: (unknown)`,
        debug
          ? `Start attempts: ${debug.lastStartAttempts ?? '(unknown)'}`
          : `Start attempts: (unknown)`,
        debug
          ? `Last connected: ${formatIso(debug.lastConnectedAt)}`
          : `Last connected: (unknown)`,
        debug && debug.lastConnectedAt ? `Connected for: ${formatDurationMs(Date.now() - debug.lastConnectedAt)}` : `Connected for: (n/a)`,
        debug && debug.lastExitCode !== null ? `Last exit code: ${debug.lastExitCode}` : `Last exit code: (none)`,
        debug?.lastError ? `Last error: ${debug.lastError}` : `Last error: (none)`,
        `Settings keys (stored): ${settingsKeys.length ? settingsKeys.join(', ') : '(none)'}`,
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

      deps.outputChannel?.appendLine(lines.join('\n'));
      deps.outputChannel?.show(true);
    }),
  );
};
