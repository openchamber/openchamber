import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { normalizeWindowsDriveLetter } from '../pathUtils';
import { resolveWorkingDirectoryChange } from '../workingDirectoryChange';
import { reapOrphanedProcesses } from '../opencodeProcessRegistry';
import {
  buildOpenCodeAuthHeader,
  generateSecureOpenCodePassword,
  isValidOpenCodePassword,
} from './auth';
import {
  appendToPath,
  resolveOpencodeCliPath,
  validateConfiguredOpencodeBinaryForManagedStart,
} from './cli-discovery';
import { applyLoginShellEnvSnapshot } from './env';
import { resolvePortFromUrl, waitForReady } from './readiness';
import { connectExternalOpenCodeUrl } from './external-url';
import { allocateManagedOpenCodePort, spawnManagedOpenCodeServer } from './spawn';
import type {
  ConnectionStatus,
  OpenCodeDebugInfo,
  OpenCodeManager,
  SetWorkingDirectoryResult,
  StatusChangeMeta,
} from './types';

const t = vscode.l10n.t;

export const READY_CHECK_TIMEOUT_MS = 30000;

export function createOpenCodeManager(context: vscode.ExtensionContext): OpenCodeManager {
  let server: { url: string; close: () => void } | null = null;
  let reapedOrphansOnce = false;
  let managedApiUrlOverride: string | null = null;
  let managedPassword: string | null = null;
  let managedPasswordSource: 'user-env' | 'generated' | 'rotated' | null = null;
  const userProvidedEnvPassword = (() => {
    const normalized = (process.env.OPENCODE_SERVER_PASSWORD || '').trim();
    return isValidOpenCodePassword(normalized) ? normalized : null;
  })();
  let status: ConnectionStatus = 'disconnected';
  let lastError: string | undefined;
  const listeners = new Set<(status: ConnectionStatus, error?: string, meta?: StatusChangeMeta) => void>();
  const workspaceDirectory = (): string =>
    normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir());
  const serverWorkingDirectory = (): string => normalizeWindowsDriveLetter(context.globalStorageUri.fsPath);
  let workingDirectory: string = workspaceDirectory();
  let startCount = 0;
  let restartCount = 0;
  let lastStartAt: number | null = null;
  let lastConnectedAt: number | null = null;
  let lastExitCode: number | null = null;
  let lastReadyElapsedMs: number | null = null;
  let lastReadyAttempts: number | null = null;
  let lastStartAttempts: number | null = null;
  let version: string | null = null;

  let detectedPort: number | null = null;
  let cliMissing = false;
  let cliPath: string | null = null;

  let pendingOperation: Promise<void> | null = null;

  const config = vscode.workspace.getConfiguration('openchamber');
  const configuredApiUrl = config.get<string>('apiUrl') || '';
  const useConfiguredUrl = configuredApiUrl && configuredApiUrl.trim().length > 0;

  let configuredPort: number | null = null;
  if (useConfiguredUrl) {
    try {
      const parsed = new URL(configuredApiUrl);
      if (parsed.port) {
        configuredPort = parseInt(parsed.port, 10);
      }
    } catch {
      // Invalid URL
    }
  }

  const getCliAvailable = (): boolean => !cliMissing || Boolean(cliPath || resolveOpencodeCliPath());

  const setStatus = (newStatus: ConnectionStatus, error?: string) => {
    if (status !== newStatus || lastError !== error) {
      status = newStatus;
      lastError = error;
      if (newStatus === 'connected') {
        lastConnectedAt = Date.now();
      }
      const meta: StatusChangeMeta = { cliAvailable: getCliAvailable() };
      listeners.forEach(cb => cb(status, error, meta));
    }
  };

  const getApiUrl = (): string | null => {
    if (useConfiguredUrl && configuredApiUrl) {
      return configuredApiUrl.replace(/\/+$/, '');
    }
    if (managedApiUrlOverride) {
      return managedApiUrlOverride.replace(/\/+$/, '');
    }
    if (server?.url) {
      return server.url.replace(/\/+$/, '');
    }
    if (detectedPort) {
      return `http://127.0.0.1:${detectedPort}`;
    }
    return null;
  };

  const getOpenCodeAuthHeaders = (): Record<string, string> => {
    const password = (managedPassword || userProvidedEnvPassword || process.env.OPENCODE_SERVER_PASSWORD || '').trim();
    if (!password) {
      return {};
    }
    return { Authorization: buildOpenCodeAuthHeader(password) };
  };

  const setManagedPasswordState = (
    password: string,
    source: 'user-env' | 'generated' | 'rotated'
  ): string => {
    const normalized = password.trim();
    managedPassword = normalized;
    managedPasswordSource = source;
    process.env.OPENCODE_SERVER_PASSWORD = normalized;
    return normalized;
  };

  const ensureManagedOpenCodeServerPassword = async ({ rotateManaged = false }: { rotateManaged?: boolean } = {}): Promise<string> => {
    if (userProvidedEnvPassword) {
      return setManagedPasswordState(userProvidedEnvPassword, 'user-env');
    }

    if (rotateManaged) {
      return setManagedPasswordState(generateSecureOpenCodePassword(), 'rotated');
    }

    if (managedPassword && isValidOpenCodePassword(managedPassword)) {
      return setManagedPasswordState(
        managedPassword,
        managedPasswordSource || 'generated'
      );
    }

    return setManagedPasswordState(generateSecureOpenCodePassword(), 'generated');
  };

  const showCliMissingError = () => {
    const openSettingsLabel = t('Open Settings');
    const retryLabel = t('Retry');
    const moreInfoLabel = t('More Info');
    setStatus('error', t('OpenCode CLI not found. Install it and ensure it\'s in PATH.'));
    void vscode.window.showErrorMessage(
      t('OpenCode CLI not found. Please install it and ensure it\'s in PATH.'),
      openSettingsLabel,
      retryLabel,
      moreInfoLabel
    ).then(selection => {
      if (selection === openSettingsLabel) {
        void vscode.commands.executeCommand('openchamber.showSettings');
      } else if (selection === retryLabel) {
        void restart();
      } else if (selection === moreInfoLabel) {
        void vscode.env.openExternal(vscode.Uri.parse('https://github.com/anomalyco/opencode'));
      }
    });
  };

  async function startInternal(
    workdir?: string,
    options: { rotateManaged?: boolean } = {}
  ): Promise<void> {
    startCount += 1;
    setStatus('connecting');
    lastStartAt = Date.now();
    lastStartAttempts = startCount;

    if (typeof workdir === 'string' && workdir.trim().length > 0) {
      workingDirectory = normalizeWindowsDriveLetter(workdir.trim());
    } else {
      workingDirectory = workspaceDirectory();
    }

    if (useConfiguredUrl && configuredApiUrl) {
      setStatus('connecting');
      const ready = await connectExternalOpenCodeUrl(
        configuredApiUrl,
        getOpenCodeAuthHeaders(),
        READY_CHECK_TIMEOUT_MS,
      );
      lastReadyElapsedMs = ready.elapsedMs;
      lastReadyAttempts = ready.attempts;
      if (ready.ok) {
        version = ready.version;
        detectedPort = ready.detectedPort;
        setStatus('connected');
      } else {
        setStatus('error', t('Failed to connect to configured OpenCode API: health check failed'));
      }
      return;
    }

    // If server already running, don't spawn another
    if (server) {
      if (status !== 'connected') {
        setStatus('connected');
      }
      return;
    }

    // Before spawning our own server, reap any OpenCode process WE spawned in a
    // prior run that was orphaned by a crash/host-kill. Verified + scoped to our
    // own pids, so it never touches a live instance's or the user's own server.
    if (!reapedOrphansOnce) {
      reapedOrphansOnce = true;
      try {
        const { reaped } = await reapOrphanedProcesses({ log: (msg) => console.log(msg) });
        if (reaped > 0) console.log(`[opencode] startup reaped ${reaped} orphaned process(es)`);
      } catch (error) {
        console.warn('[opencode] orphan reap failed:', error instanceof Error ? error.message : error);
      }
    }

    setStatus('connecting');
    cliMissing = false;
    cliPath = null;

    detectedPort = null;
    lastExitCode = null;
    managedApiUrlOverride = null;

    try {
      applyLoginShellEnvSnapshot();

      const configuredCli = validateConfiguredOpencodeBinaryForManagedStart();
      if (configuredCli) {
        cliPath = configuredCli;
        appendToPath(path.dirname(configuredCli));
        process.env.OPENCODE_BINARY = configuredCli;
      }

      // Best-effort: locate CLI even when VS Code PATH is stale.
      const resolvedCli = configuredCli || resolveOpencodeCliPath();
      if (resolvedCli) {
        cliPath = resolvedCli;
        appendToPath(path.dirname(resolvedCli));
        process.env.OPENCODE_BINARY = resolvedCli;
      }

      const password = await ensureManagedOpenCodeServerPassword({
        rotateManaged: options.rotateManaged === true,
      });
      process.env.OPENCODE_SERVER_PASSWORD = password;

      // Match the web runtime: keep the server process in a neutral cwd and pass
      // the selected workspace through explicit `directory` API parameters.
      const serverCwd = serverWorkingDirectory();
      const originalCwd = process.cwd();
      try {
        fs.mkdirSync(serverCwd, { recursive: true });
        process.chdir(serverCwd);
        const port = await allocateManagedOpenCodePort();
        server = await spawnManagedOpenCodeServer(serverCwd, port, READY_CHECK_TIMEOUT_MS);
      } finally {
        try {
          process.chdir(originalCwd);
        } catch {
          // ignore
        }
      }

      if (server && server.url) {
        // Validate readiness for the current workspace context.
        const ready = await waitForReady(server.url, READY_CHECK_TIMEOUT_MS, getOpenCodeAuthHeaders());
        lastReadyElapsedMs = ready.elapsedMs;
        lastReadyAttempts = ready.attempts;
        if (ready.ok) {
          managedApiUrlOverride = ready.baseUrl;
          detectedPort = resolvePortFromUrl(ready.baseUrl);
          version = ready.version;
          setStatus('connected');
        } else {
          try {
            server.close();
          } catch {
            // ignore
          }
          server = null;
          throw new Error('Server started but health check failed');
        }
      } else {
        throw new Error('Server started but URL is missing');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check for ENOENT or generic spawn failure which implies CLI missing
      if (message.includes('ENOENT') || message.includes('spawn opencode')) {
        cliMissing = true;
        if (!cliPath) {
          cliPath = resolveOpencodeCliPath();
        }
        showCliMissingError();
      } else {
        setStatus('error', t('Failed to start OpenCode: {0}', message));
      }
    }
  }

  async function stopInternal(): Promise<void> {
    const portToKill = detectedPort;

    if (server) {
      try {
        server.close();
      } catch {
        // Ignore close errors
      }
      server = null;
    }

    // Kill any process listening on our port to clean up orphaned children.
    if (portToKill) {
      try {
        const lsofOutput = execSync(`lsof -ti:${portToKill} 2>/dev/null || true`, {
          encoding: 'utf8',
          timeout: 5000
        });
        const myPid = process.pid;
        for (const pidStr of lsofOutput.split(/\s+/)) {
          const pid = parseInt(pidStr.trim(), 10);
          if (pid && pid !== myPid) {
            try {
              execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 2000 });
            } catch {
              // Ignore
            }
          }
        }
      } catch {
        // Ignore - process may already be dead
      }
    }

    managedApiUrlOverride = null;
    detectedPort = null;
    version = null;
    setStatus('disconnected');
  }

  async function restartInternal(): Promise<void> {
    restartCount += 1;
    const restartDirectory = workingDirectory;
    await stopInternal();
    await new Promise(r => setTimeout(r, 250));
    await startInternal(restartDirectory, { rotateManaged: true });
  }

  async function start(workdir?: string): Promise<void> {
    if (pendingOperation) {
      await pendingOperation;
      if (server) {
        return;
      }
    }
    lastStartAttempts = 1;
    pendingOperation = startInternal(workdir, { rotateManaged: true });
    try {
      await pendingOperation;
    } finally {
      pendingOperation = null;
    }
  }

  async function stop(): Promise<void> {
    if (pendingOperation) {
      await pendingOperation;
    }
    // Check if already stopped
    if (!server) {
      return;
    }
    pendingOperation = stopInternal();
    try {
      await pendingOperation;
    } finally {
      pendingOperation = null;
    }
  }

  async function restart(): Promise<void> {
    if (pendingOperation) {
      await pendingOperation;
    }
    lastStartAttempts = 1;
    pendingOperation = restartInternal();
    try {
      await pendingOperation;
    } finally {
      pendingOperation = null;
    }
  }

  async function setWorkingDirectory(newPath: string): Promise<SetWorkingDirectoryResult> {
    const trimmed = newPath.trim();
    if (!trimmed) {
      return { success: false, error: 'path not found' };
    }

    let stat;
    try {
      stat = await fs.promises.stat(trimmed);
    } catch {
      return { success: false, error: 'path not found' };
    }
    if (!stat.isDirectory()) {
      return { success: false, error: 'path not found' };
    }

    const change = resolveWorkingDirectoryChange(workingDirectory, trimmed);
    if (!change.changed) {
      return { success: true, path: change.path };
    }

    workingDirectory = change.path;
    return { success: true, path: change.path };
  }

  return {
    start,
    stop,
    restart,
    setWorkingDirectory,
    getStatus: () => status,
    getApiUrl,
    getOpenCodeAuthHeaders,
    getWorkingDirectory: () => workingDirectory,
    isCliAvailable: getCliAvailable,
    getDebugInfo: (): OpenCodeDebugInfo => {
      const secureConnection = Boolean(getOpenCodeAuthHeaders().Authorization);
      const detectedCliPath = cliPath || resolveOpencodeCliPath();
      return {
        mode: useConfiguredUrl && configuredApiUrl ? 'external' : 'managed',
        status,
        lastError,
        workingDirectory,
        cliAvailable: getCliAvailable(),
        cliPath: detectedCliPath,
        configuredApiUrl: useConfiguredUrl && configuredApiUrl ? configuredApiUrl.replace(/\/+$/, '') : null,
        configuredPort,
        detectedPort,
        apiPrefix: '',
        apiPrefixDetected: true,
        startCount,
        restartCount,
        lastStartAt,
        lastConnectedAt,
        lastExitCode,
        serverUrl: getApiUrl(),
        lastReadyElapsedMs,
        lastReadyAttempts,
        lastStartAttempts,
        version,
        secureConnection,
        authSource: managedPasswordSource || (userProvidedEnvPassword ? 'user-env' : null),
      };
    },
    onStatusChange(callback) {
      listeners.add(callback);
      callback(status, lastError, { cliAvailable: getCliAvailable() });
      return new vscode.Disposable(() => listeners.delete(callback));
    },
  };
}
