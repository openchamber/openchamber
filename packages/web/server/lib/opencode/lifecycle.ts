import { readOpenCodeInfo, readExternalOpenCodeVersion, isSupportedOpenCodeVersion, requireOpenCodeV2, UnsupportedOpenCodeVersionError } from './compatibility.js';
import { spawn, spawnSync } from 'node:child_process';
import { createDefaultDirectory } from './default-directory.js';
import net from 'node:net';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv } from '../inherited-env.js';
import { assignInjectedEnv } from '../injected-env.js';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } from './managed-process-registry.js';
import { hasChildProcessExited, stopOpenCodeByClosingStdin, waitForChildProcessClose } from './managed-process-stop.js';
import { prepareManagedOpenCodeEnv } from './managed-opencode-env.js';
import { overlayEnvironment } from '../environment/variables.js';
import { recordStartupPerformance } from '../diagnostics/startup-performance.js';
import { topUpV1Migration } from './v1-migration-topup.js';
import { attachSharedService, restoreSharedServiceState, type SharedOpenCodeServiceConnector } from './shared-service.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';
import type { ChildProcess } from 'node:child_process';
import type { Application } from '../shared/http-contracts.js';
import type { DiagnosticJournal } from '../diagnostics/contracts.js';
import type { EnvironmentVariables, ProcessEnvironment } from '../environment/variables.js';

export interface ManagedOpenCodeProcess {
  url: string | null | undefined;
  pid: number | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrTail: string;
  close: () => Promise<void>;
}

export interface ManagedOpenCodeProcessSnapshot {
  pid: number | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrTail: string;
}

export interface OpenCodeHealthFailure {
  class: string;
  detail: string;
}

export interface OpenCodeHealthResult {
  healthy: boolean;
  failure: OpenCodeHealthFailure | null;
}

export interface OpenCodeHealthProbeResult extends OpenCodeHealthResult {
  at: number;
}

export interface OpenCodeLaunchDiagnostics {
  launchedAt: string;
  sourceBinary: string;
  binary: string;
  args: string[];
  cwd: string;
  hostname: string;
  port: number;
  wrapperType: string | null;
  pathEntryCount: number;
  hasShellEnv: boolean;
  shellEnvKeysCount: number;
}

export interface OpenCodeHealthFailureSnapshot extends OpenCodeHealthFailure {
  at: string;
  source: string;
}

export interface OpenCodeRestartDiagnostics {
  reason: string;
  healthFailure: OpenCodeHealthFailureSnapshot | null;
  process: (ManagedOpenCodeProcessSnapshot & { alive: boolean }) | null;
  busySessionCount: number;
  at: string;
}

export interface OpenCodeLifecycleState {
  openCodeProcess: ManagedOpenCodeProcess | null;
  openCodePort: number | null;
  openCodeBaseUrl: string | null;
  openCodeWorkingDirectory: string;
  currentRestartPromise: Promise<boolean> | null;
  isRestartingOpenCode: boolean;
  openCodeApiPrefix: string;
  openCodeApiPrefixDetected: boolean;
  openCodeApiDetectionTimer: ReturnType<typeof setTimeout> | null;
  lastOpenCodeError: unknown;
  lastOpenCodeLaunchDiagnostics: OpenCodeLaunchDiagnostics | null;
  lastOpenCodeHealthFailure: OpenCodeHealthFailureSnapshot | null;
  lastManagedOpenCodeProcess: ManagedOpenCodeProcessSnapshot | null;
  lastOpenCodeRestartDiagnostics: OpenCodeRestartDiagnostics | null;
  isOpenCodeReady: boolean;
  openCodeNotReadySince: number;
  isExternalOpenCode: boolean;
  isShuttingDown: boolean;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  expressApp: Application | null;
  useWslForOpencode: boolean;
}

export interface ManagedOpenCodeLaunchSpec {
  binary: string;
  args: string[];
  wrapperType?: string | null;
  env?: ProcessEnvironment;
}

export interface OpenCodeLifecycleDependencies {
  state: OpenCodeLifecycleState;
  env: {
    ENV_CONFIGURED_OPENCODE_PORT: number | null;
    ENV_CONFIGURED_OPENCODE_HOST?: { origin: string; port: number } | null;
    ENV_EFFECTIVE_PORT?: number | null;
    ENV_CONFIGURED_OPENCODE_HOSTNAME: string;
    ENV_SKIP_OPENCODE_START?: boolean;
  };
  syncToHmrState: () => void;
  syncFromHmrState: () => void;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  buildOpenCodeUrl: (route: string, prefixOverride?: string) => string;
  waitForReady: (url: string, timeoutMs: number) => Promise<boolean>;
  normalizeApiPrefix: (prefix: string) => string;
  applyOpencodeBinaryFromSettings: (options?: { strict: boolean }) => Promise<string | null | void>;
  ensureOpencodeCliEnv: () => string | null | undefined;
  ensureLocalOpenCodeServerPassword: (options: { rotateManaged: boolean }) => Promise<string | null>;
  resolveManagedOpenCodeLaunchSpec: (binary: string | null | undefined) => ManagedOpenCodeLaunchSpec;
  setOpenCodePort: (port: number) => void;
  setDetectedOpenCodeApiPrefix: (prefix: string) => void;
  setupProxy: (app: Application) => void;
  ensureOpenCodeApiPrefix: () => void;
  clearResolvedOpenCodeBinary: () => void;
  buildAugmentedPath?: () => string;
  buildManagedOpenCodePath?: () => string;
  getManagedOpenCodeShellEnvSnapshot?: () => ProcessEnvironment | null;
  getManagedOpenCodeEnv?: () => Promise<ProcessEnvironment>;
  getUserEnvironment?: () => EnvironmentVariables;
  getActiveSessionCount?: () => number;
  reapManagedOrphanedProcesses?: typeof reapOrphanedProcesses;
  getWarmupDirectories?: () => Promise<Array<string | null>>;
  noProjectDirectory?: string | null;
  onOpenCodeRestarted?: (() => void) | null;
  managedStartupTimeoutMs?: number;
  now?: () => number;
  topUpV1SessionMigration?: typeof topUpV1Migration;
  checkOpenCodeBinary?: (launch: ManagedOpenCodeLaunchSpec) => Promise<string>;
  diagnosticJournal?: DiagnosticJournal;
  sharedService?: SharedOpenCodeServiceConnector | null;
}

interface ManagedOpenCodeServerOptions {
  resolvedBinary: string | null | undefined;
  hostname: string;
  port: number;
  timeout: number;
  cwd: string;
  env: ProcessEnvironment;
  shellEnvKeysCount?: number;
  attempt: number;
}

interface LifecycleFailure {
  cause: unknown;
}

interface AgentPresenceHeaders extends Record<string, string> {
  Accept: string;
  'x-opencode-directory'?: string;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
const hasErrorFields = (cause: unknown): cause is { name?: unknown; code?: unknown; message?: unknown } => cause != null;
const errorFields = <Cause>(cause: Cause) => {
  if (hasErrorFields(cause)) return cause;
  throw new TypeError(`Cannot read properties of ${cause} (reading 'message')`);
};
const optionalErrorFields = <Cause>(cause: Cause) => hasErrorFields(cause) ? cause : undefined;
const hasVersion = (value: unknown): value is { version: unknown } => value != null && 'version' in Object(value);
const hasAgentData = (value: unknown): value is { data: unknown } => value != null && 'data' in Object(value);
const hasAgentId = (value: unknown): value is { id: unknown } => value != null && 'id' in Object(value);

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEALTH_CHECK_TIMEOUT_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000);
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0);
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
const BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const EXTERNAL_READINESS_RECHECK_MS = 5_000;
const OPENCODE_HEALTH_PATH = '/api/info';
const OPENCODE_REQUIRED_MAJOR_VERSION = 2;

const OPENCODE_VERSION_REQUIREMENT_DETAIL =
  `OpenChamber requires OpenCode ${OPENCODE_REQUIRED_MAJOR_VERSION}.x`;

const classifyOpenCodeVersion = (version: string | undefined): { ok: true } | { ok: false; detail: string } => {
  if (version === undefined) return { ok: true };
  const match = version.match(/v?(\d+)\./);
  if (!match) return { ok: true };
  if (Number(match[1]) >= OPENCODE_REQUIRED_MAJOR_VERSION) return { ok: true };
  return {
    ok: false,
    detail: `${OPENCODE_VERSION_REQUIREMENT_DETAIL}, found ${version.trim()}. Update OpenCode and start OpenChamber again.`,
  };
};
const WARMUP_DIRECTORY_LIMIT = 1;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;
const MANAGED_STDERR_TAIL_MAX_BYTES = 32 * 1024;
const HEALTH_FAILURE_DETAIL_MAX_LENGTH = 256;

const getBoundedTextTail = (value: string | null | undefined, maxBytes: number) => {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.byteLength <= maxBytes) return buffer.toString();
  return buffer.subarray(buffer.byteLength - maxBytes).toString();
};

const sanitizeDiagnosticText = (value: string | null | undefined) => String(value ?? '')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
  .replace(
    /(^|[\s,{[])((?:"|')?[a-z0-9_.-]{0,80}authorization[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*(?:"|')?(?:basic|bearer|token)\s+)[^\s,;"']+/gim,
    '$1$2[redacted]',
  )
  .replace(/([?&][^=&#\s]*(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[^=&#\s]*=)[^&#\s]+/gi, '$1[redacted]')
  .replace(
    /(^|[\s,{[])((?:"|')?[a-z0-9_.-]{0,80}(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gim,
    '$1$2[redacted]',
  );

const getHealthFailureDetail = (cause: unknown) => {
  const name = String(optionalErrorFields(cause)?.name || 'Error');
  const message = String(optionalErrorFields(cause)?.message || cause || 'Unknown error');
  return sanitizeDiagnosticText(`${name}: ${message}`).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH);
};

const classifyHealthProbeError = (cause: unknown) => {
  const name = String(optionalErrorFields(cause)?.name || '');
  const code = String(optionalErrorFields(cause)?.code || '').toUpperCase();
  const message = String(optionalErrorFields(cause)?.message || cause || '');
  const normalizedMessage = message.toLowerCase();

  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || normalizedMessage.includes('the operation was aborted')
    || normalizedMessage.includes('abortsignal.timeout')
  ) {
    return { class: 'timeout', detail: getHealthFailureDetail(cause) };
  }
  if (code === 'ECONNREFUSED' || normalizedMessage.includes('econnrefused')) {
    return { class: 'connection_refused', detail: getHealthFailureDetail(cause) };
  }
  if (
    code === 'ECONNRESET'
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('socket hang up')
  ) {
    return { class: 'connection_reset', detail: getHealthFailureDetail(cause) };
  }
  return { class: 'error', detail: getHealthFailureDetail(cause) };
};

export const createOpenCodeLifecycleRuntime = (deps: OpenCodeLifecycleDependencies) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOpenCodeEnv = async () => ({}),
    getUserEnvironment = () => ({}),
    getActiveSessionCount = () => 0,
    reapManagedOrphanedProcesses = reapOrphanedProcesses,
    getWarmupDirectories = async () => [],
    noProjectDirectory = null,
    onOpenCodeRestarted = null,
    managedStartupTimeoutMs = 30_000,
    now = Date.now,
    topUpV1SessionMigration = topUpV1Migration,
    checkOpenCodeBinary = requireOpenCodeV2,
    diagnosticJournal = serverDiagnosticJournal,
    sharedService = null,
  } = deps;

  let managedPreflight: Promise<boolean> | null = null;
  let managedProcessEnv: ProcessEnvironment | null = null;
  let connectedViaSharedService = false;

  const killProcessOnPortWin32 = (port: number) => {
    try {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-NetTCPConnection -State Listen -LocalPort ${Number.parseInt(String(port), 10)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const output = result.stdout || '';
      const myPid = process.pid;
      const pids = new Set<number>();
      for (const line of output.split(/\r?\n/)) {
        const pid = Number.parseInt(line.trim(), 10);
        if (pid && pid !== myPid) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
        } catch {
          void 0;
        }
      }
    } catch {
      void 0;
    }
  };

  const killProcessOnPort = (port: number | null) => {
    if (!port) return;
    if (process.platform === 'win32') {
      killProcessOnPortWin32(port);
      return;
    }
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const output = result.stdout || '';
      const myPid = process.pid;
      for (const pidStr of output.split(/\s+/)) {
        const pid = parseInt(pidStr.trim(), 10);
        if (pid && pid !== myPid) {
          try {
            spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 2000 });
          } catch {
            void 0;
          }
        }
      }
    } catch {
      void 0;
    }
  };

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const snapshotManagedOpenCodeProcess = (child = state.openCodeProcess) => {
    if (!child) return null;
    const snapshot = {
      pid: child.pid || null,
      exitCode: child.exitCode ?? null,
      signalCode: child.signalCode ?? null,
      stderrTail: getBoundedTextTail(
        sanitizeDiagnosticText(child.stderrTail ?? ''),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      ),
    };
    state.lastManagedOpenCodeProcess = snapshot;
    return snapshot;
  };

  const captureRestartDiagnostics = (reason: string) => {
    const processSnapshot = snapshotManagedOpenCodeProcess();
    const diagnostics = {
      reason: sanitizeDiagnosticText(String(reason || 'managed-restart')).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH),
      healthFailure: state.lastOpenCodeHealthFailure ? { ...state.lastOpenCodeHealthFailure } : null,
      process: processSnapshot
        ? { ...processSnapshot, alive: isManagedOpenCodeProcessAlive() }
        : null,
      busySessionCount: getActiveSessionCount(),
      at: new Date(now()).toISOString(),
    };
    state.lastOpenCodeRestartDiagnostics = diagnostics;
    console.warn('[lifecycle] managed OpenCode restart diagnostics', diagnostics);
  };

  const waitForPortRelease = (port: number | null, timeoutMs: number, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise<boolean>((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released: boolean) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && (errorFields(error).code === 'ECONNREFUSED' || errorFields(error).code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  };

  const terminateChildProcess = async (child: ChildProcess | null) => {
    if (!child) {
      return;
    }

    const pid = child.pid;
    if (!pid || (process.platform === 'win32' && hasChildProcessExited(child))) {
      await waitForChildProcessClose(child, 250);
      return;
    }

    const signalProcessTree = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
          void 0;
        }
      }

      try {
        if (!hasChildProcessExited(child)) child.kill(signal);
      } catch {
        void 0;
      }
    };

    if (process.platform === 'win32') {
      await stopOpenCodeByClosingStdin(child, {
        forceKillTree: (treePid: number | undefined) => {
          try {
            spawnSync('taskkill', ['/pid', String(treePid), '/f', '/t'], {
              stdio: 'ignore',
              timeout: 5000,
              windowsHide: true,
            });
          } catch {
            void 0;
          }
        },
      });
      return;
    }

    signalProcessTree('SIGTERM');
    await waitForChildProcessClose(child, 2500);
    signalProcessTree('SIGKILL');

    await waitForChildProcessClose(child, 1000);
  };

  const closeManagedOpenCodeChild = async (child: ChildProcess) => {
    const pid = child?.pid;
    try {
      await terminateChildProcess(child);
    } finally {
      if (Number.isInteger(pid) && hasChildProcessExited(child)) {
        await unregisterManagedProcess(pid);
      }
    }
  };

  const formatCapturedOutput = ({ stdout, stderr }: { stdout: string; stderr: string }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const createManagedOpenCodeServerProcess = async ({ resolvedBinary, hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0, attempt }: ManagedOpenCodeServerOptions) => {
    let binary = (resolvedBinary || process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const sourceBinary = binary;
    const stdinLease = process.platform === 'win32';
    let args = ['serve', ...(stdinLease ? ['--stdio'] : []), '--hostname', hostname, '--port', String(port)];
    let launchWrapperType: string | null = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      throw new Error('Launching OpenCode through WSL is no longer supported. Install OpenCode natively on Windows and configure opencode.cmd or opencode.exe.');
    }

    const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
    if (launchSpec?.binary) {
      if (launchSpec.wrapperType) {
        console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
      }
      launchWrapperType = launchSpec.wrapperType || null;
      binary = launchSpec.binary;
      args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
    }

    const pathValue = processEnv?.PATH ?? '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      sourceBinary,
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    const child = spawn(binary, args, {
      cwd,
      env: launchSpec?.env ? { ...processEnv, ...launchSpec.env } : processEnv,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [stdinLease ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});
    let runtimeStderrTail = '';
    let runtimeStderrAttached = false;
    let observedExitCode: number | null = null;
    let observedSignalCode: NodeJS.Signals | null = null;
    let recordedExit = false;
    diagnosticJournal.record('managed launch', { attempt });

    const getManagedProcessSnapshot = () => ({
      pid: child.pid || null,
      exitCode: observedExitCode ?? child.exitCode ?? null,
      signalCode: observedSignalCode ?? child.signalCode ?? null,
      stderrTail: getBoundedTextTail(sanitizeDiagnosticText(runtimeStderrTail), MANAGED_STDERR_TAIL_MAX_BYTES),
    });
    const recordManagedProcessExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null && code !== undefined) observedExitCode = code;
      if (signal !== null && signal !== undefined) observedSignalCode = signal;
      state.lastManagedOpenCodeProcess = getManagedProcessSnapshot();
      if (!recordedExit) {
        recordedExit = true;
        diagnosticJournal.record('managed process exited');
      }
    };
    const attachRuntimeStderrCapture = () => {
      if (runtimeStderrAttached) return;
      runtimeStderrAttached = true;
      child.stderr?.on('data', (chunk: Buffer) => {
        runtimeStderrTail = getBoundedTextTail(
          `${runtimeStderrTail}${chunk.toString()}`,
          MANAGED_STDERR_TAIL_MAX_BYTES,
        );
      });
    };
    child.on('exit', recordManagedProcessExit);
    child.on('close', recordManagedProcessExit);

    const registration = registerManagedProcess({
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binary,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
    });

    let closePromise: Promise<void> | null = null;
    const serverProcess: ManagedOpenCodeProcess = {
      url: null,
      pid: child.pid || null,
      get exitCode() { return observedExitCode ?? child.exitCode; },
      get signalCode() { return observedSignalCode ?? child.signalCode; },
      get stderrTail() { return getManagedProcessSnapshot().stderrTail; },
      close() {
        if (!closePromise) closePromise = registration.then(() => closeManagedOpenCodeChild(child));
        return closePromise;
      },
    };

    const readiness = new Promise<string | undefined>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = <Value,>(handler: (value: Value) => void, value: Value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/server listening on\s+(https?:\/\/\S+)/)
            ?? line.match(/^\s*\{"url":"(https?:\/\/[^"\s]+)"\}\s*$/);
          if (!match) continue;
          attachRuntimeStderrCapture();
          finish(resolve, match[1]);
          return;
        }
      };

      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString();
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
          ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
          : '';
        finish(reject, new Error(`OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${formatCapturedOutput({ stdout, stderr })}`));
      };

      const onError = (error: Error) => {
        finish(reject, error);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
      }, timeout);

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
    }).catch(async (error) => {
      await serverProcess.close();
      if (state.openCodeProcess === serverProcess) {
        state.openCodeProcess = null;
        syncToHmrState();
      }
      throw error;
    });

    state.openCodeProcess = serverProcess;
    syncToHmrState();
    serverProcess.url = await readiness;
    await registration;
    return serverProcess;
  };

  const resolveManagedOpenCodePort = async (requestedPort: number, hostname = '127.0.0.1') => {
    if (Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && isObject(address) ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const probeOpenCodeHealthDetailed = async (): Promise<OpenCodeHealthResult> => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return {
        healthy: false,
        failure: {
          class: 'error',
          detail: 'Managed OpenCode process or port is unavailable',
        },
      };
    }

    try {
      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: response.status === 404
              ? `${OPENCODE_VERSION_REQUIREMENT_DETAIL}: this server has no /api/info, which every 2.x server serves.`
              : `Info endpoint returned HTTP ${response.status ?? 'unknown'}`,
          },
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Info endpoint returned invalid JSON',
          },
        };
      }
      const version = classifyOpenCodeVersion(hasVersion(body) && isString(body.version) ? body.version : undefined);
      if (!version.ok) {
        return {
          healthy: false,
          failure: { class: 'invalid_response', detail: version.detail },
        };
      }
      return { healthy: true, failure: null };
    } catch (error) {
      return {
        healthy: false,
        failure: classifyHealthProbeError(error),
      };
    }
  };

  const isOpenCodeProcessHealthy = async () => (await probeOpenCodeHealthDetailed()).healthy;

  const probeExternalOpenCode = async (port: number, origin: string | null | undefined, { signal }: { signal?: AbortSignal } = {}) => {
    if (!port || port <= 0) {
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    const aborted = new Promise<null>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      const info = await Promise.race([readOpenCodeInfo(response), aborted]);
      return !controller.signal.aborted && info !== null && isSupportedOpenCodeVersion(info.version);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };

  const readUnsupportedExternalOpenCodeVersion = async (port: number, origin: string | null | undefined) => {
    if (!port || port <= 0) return null;
    const version = await readExternalOpenCodeVersion(origin ?? `http://127.0.0.1:${port}`, getOpenCodeAuthHeaders())
      .catch(() => null);
    return version && !isSupportedOpenCodeVersion(version) ? version : null;
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const lastBootstrapError: LifecycleFailure = { cause: null };
  let bootstrapRetryCount = 0;
  let bootstrapRetryRun: Promise<void> | null = null;
  let externalReadinessTimer: ReturnType<typeof setInterval> | null = null;
  let externalReadinessProbe: AbortController | null = null;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const isBinaryRejected = (cause: unknown) => cause instanceof UnsupportedOpenCodeVersionError || optionalErrorFields(cause)?.code === 'OPENCODE_BINARY_INVALID';

  const startOpenCodeOnce = async (attempt: number) => {
    const attemptStartedAt = performance.now();
    let phaseStartedAt = attemptStartedAt;
    recordStartupPerformance('opencode.attempt.start', { attempt });
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings({ strict: true });
    const resolvedBinary = ensureOpencodeCliEnv();
    const preflight = checkOpenCodeBinary(resolveManagedOpenCodeLaunchSpec(resolvedBinary));
    managedPreflight = preflight.then(() => true, () => false);
    await preflight;
    recordStartupPerformance('opencode.binary.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    let envPath = process.env.PATH;
    if (buildManagedOpenCodePath) {
      envPath = buildManagedOpenCodePath();
    } else if (buildAugmentedPath) {
      envPath = buildAugmentedPath();
    }
    const shellEnv = getManagedOpenCodeShellEnvSnapshot
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    const managedOpenCodeEnv = await getManagedOpenCodeEnv();
    recordStartupPerformance('opencode.environment.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();

    const inheritedEnv = overlayEnvironment({ ...shellEnv, ...process.env, PATH: envPath }, getUserEnvironment());

    try {
      const topUp = topUpV1SessionMigration({ env: inheritedEnv });
      if (topUp && topUp.status !== 'skipped') {
        console.log('[OpenCode] V1 session migration top-up:', topUp);
      }
    } catch (error) {
      console.warn('[OpenCode] V1 session migration top-up failed:', error instanceof Error ? error.message : error);
    }

    const processEnv = stripAppImageLauncherEnv(stripAppImageArgv0Leak(prepareManagedOpenCodeEnv(assignInjectedEnv(
      { ...inheritedEnv },
      {
        ...managedOpenCodeEnv,
        PATH: inheritedEnv.PATH,
        OPENCODE_PASSWORD: openCodePassword ?? undefined,
        OPENCODE_SERVER_PASSWORD: openCodePassword ?? undefined,
      },
    ))));
    managedProcessEnv = processEnv;

    let serverInstance;
    try {
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      serverInstance = await createManagedOpenCodeServerProcess({
        resolvedBinary,
        attempt,
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: managedStartupTimeoutMs,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: processEnv,
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }
      recordStartupPerformance('opencode.process.ready', {
        attempt,
        durationMs: performance.now() - phaseStartedAt,
        totalDurationMs: performance.now() - attemptStartedAt,
      });
      phaseStartedAt = performance.now();

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      const ready = await waitForReady(serverInstance.url, 10000);
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      if (ready) {
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        diagnosticJournal.record('managed ready', { attempt });
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        recordStartupPerformance('opencode.health.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
          outcome: 'ready',
        });

        return serverInstance;
      }

      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      diagnosticJournal.record('managed startup failed', { attempt });
      await serverInstance?.close();
      if (serverInstance && state.openCodeProcess === serverInstance) state.openCodeProcess = null;
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      syncToHmrState();
      recordStartupPerformance('opencode.attempt.error', {
        attempt,
        totalDurationMs: performance.now() - attemptStartedAt,
        outcome: 'error',
      });
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    managedPreflight = null;
    const lastError: LifecycleFailure = { cause: null };
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce(attempt);
      } catch (error) {
        lastError.cause = error;
        if (state.isShuttingDown || isBinaryRejected(error)) {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError.cause;
  };

  const sharedServiceTarget = () => ({ state, setOpenCodePort, recordDiagnostic: (event: string) => diagnosticJournal.record(event), syncToHmrState, killProcessOnPort, waitForPortRelease, setupProxy: () => state.expressApp && setupProxy(state.expressApp), ensureOpenCodeApiPrefix, onOpenCodeRestarted });

  const restartOpenCode = async (reason = 'managed-restart', { whileStopped }: { whileStopped?: () => Promise<void> } = {}): Promise<boolean> => {
    if (state.isShuttingDown) return false;
    while (state.currentRestartPromise || bootstrapRetryRun) {
      if (state.currentRestartPromise && !whileStopped) return state.currentRestartPromise;
      await (state.currentRestartPromise ?? bootstrapRetryRun)?.catch(() => {});
    }
    if (state.isShuttingDown) return false;
    if (whileStopped && state.isExternalOpenCode) throw new Error('An external OpenCode server cannot be stopped by OpenChamber.');

    const whileStoppedError: LifecycleFailure = { cause: null };
    const runWhileStopped = async () => {
      try { await whileStopped?.(); } catch (error) { whileStoppedError.cause = error; }
    };
    state.currentRestartPromise = (async () => {
      managedPreflight = null;
      state.isRestartingOpenCode = true;
      if (!state.isExternalOpenCode) diagnosticJournal.record('managed restart started');
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      const canUseSharedService = !env.ENV_SKIP_OPENCODE_START && !env.ENV_CONFIGURED_OPENCODE_HOST && !env.ENV_EFFECTIVE_PORT;
      const wantSharedService = canUseSharedService && Boolean(await sharedService?.isEnabled());
      if (wantSharedService && sharedService) { const replaced = await attachSharedService(sharedService, sharedServiceTarget(), { stopManaged: !state.isExternalOpenCode }); connectedViaSharedService = true; await runWhileStopped(); return replaced; }

      const leavingShared = connectedViaSharedService && !wantSharedService;
      if (state.isExternalOpenCode && !leavingShared) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort ?? env.ENV_EFFECTIVE_PORT ?? 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (!healthy) {
          diagnosticJournal.record('external unavailable');
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }
        console.log(`External OpenCode server on port ${probePort} is healthy`);
        state.openCodeBaseUrl = probeOrigin ?? null; setOpenCodePort(probePort); state.isOpenCodeReady = true;
        diagnosticJournal.record('external connected'); state.lastOpenCodeError = null; state.openCodeNotReadySince = 0; syncToHmrState();
        if (state.expressApp) { setupProxy(state.expressApp); ensureOpenCodeApiPrefix(); }
        return false;
      }
      const prevShared = leavingShared ? { origin: state.openCodeBaseUrl, port: state.openCodePort } : null;
      if (leavingShared) {
        connectedViaSharedService = false; state.isExternalOpenCode = false; state.openCodeBaseUrl = null;
        await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
      }

      captureRestartDiagnostics(reason);
      const portToKill = state.openCodePort;
      if (!leavingShared) {
        if (state.openCodeProcess) {
          console.log('Stopping existing OpenCode process...');
          await state.openCodeProcess.close().catch((error) => console.warn('Error closing OpenCode process:', error));
          state.openCodeProcess = null; syncToHmrState();
        }
        killProcessOnPort(portToKill);
        if (!(await waitForPortRelease(portToKill, 5000))) console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released`);
      }

      await runWhileStopped();

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      try { state.openCodeProcess = await startOpenCode(); } catch (error) {
        if (prevShared) { await restoreSharedServiceState(sharedService, prevShared, { state, setOpenCodePort, syncToHmrState }); connectedViaSharedService = true; }
        throw error;
      }
      diagnosticJournal.record('managed restart ready');
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }

      try {
        onOpenCodeRestarted?.();
      } catch (error) {
        console.warn('Failed to rebind event stream after OpenCode restart:', optionalErrorFields(error)?.message ?? error);
      }
      return false;
    })();

    let result: boolean;
    try {
      result = await state.currentRestartPromise;
    } catch (error) {
      if (!state.isExternalOpenCode) diagnosticJournal.record('managed restart failed');
      console.error(`Failed to restart OpenCode: ${errorFields(error).message}`);
      state.lastOpenCodeError = errorFields(error).message;
      if (!env.ENV_EFFECTIVE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
    if (whileStoppedError.cause) throw whileStoppedError.cause;
    return result;
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    const lastError: LifecycleFailure = { cause: null };

    while (Date.now() < deadline) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
          lastError.cause = new Error(`OpenCode info endpoint responded with status ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        const info = await readOpenCodeInfo(response);
        if (!info) throw new Error('The server did not identify itself as OpenCode 2.x. OpenChamber requires OpenCode 2.x; if the server runs an older OpenCode, upgrade it.');
        if (!isSupportedOpenCodeVersion(info.version)) throw new UnsupportedOpenCodeVersionError(info.version);
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError.cause = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError.cause) {
      state.lastOpenCodeError = errorFields(lastError.cause).message || String(lastError.cause);
      throw lastError.cause;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName: string, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const headers: AgentPresenceHeaders = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
        const scopedDirectory = await defaultDirectory.get();
        if (scopedDirectory) headers['x-opencode-directory'] = encodeURIComponent(scopedDirectory);
        const response = await fetch(buildOpenCodeUrl('/api/agent'), { method: 'GET', headers });

        if (response.ok) {
          const body: unknown = await response.json();
          const agents: unknown = Array.isArray(body) ? body : hasAgentData(body) ? body.data : undefined;
          if (Array.isArray(agents) && agents.some((agent) => hasAgentId(agent) && agent.id === agentName)) {
            return;
          }
        }
      } catch {
        void 0;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason: string, options: { agentName?: string } = {}) => {
    const { agentName } = options;
    const wasExternal = state.isExternalOpenCode === true;

    console.log(`Refreshing OpenCode after ${reason}`);
    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    const replaced = await restartOpenCode(reason || 'config-change');
    const external = state.isExternalOpenCode === true;

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      if (agentName && !external) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, errorFields(error).message);
      throw error;
    }

    const manualRestart = external && wasExternal && !replaced;
    return { reloaded: !manualRestart, external: manualRestart };
  };

  const stopExternalReadinessRecheck = () => {
    externalReadinessProbe?.abort();
    externalReadinessProbe = null;
    if (!externalReadinessTimer) return;
    clearInterval(externalReadinessTimer);
    externalReadinessTimer = null;
  };

  const recheckExternalReadiness = async () => {
    if (state.isShuttingDown || !state.isExternalOpenCode) {
      stopExternalReadinessRecheck();
      return;
    }
    if (state.isOpenCodeReady) {
      stopExternalReadinessRecheck();
      return;
    }
    if (externalReadinessProbe) return;
    const probePort = state.openCodePort ?? env.ENV_EFFECTIVE_PORT;
    if (!probePort) return;
    const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
    const endpointBefore = { baseUrl: state.openCodeBaseUrl, port: state.openCodePort };
    const probe = new AbortController();
    externalReadinessProbe = probe;
    let healthy;
    try {
      healthy = await probeExternalOpenCode(probePort, probeOrigin, { signal: probe.signal });
    } finally {
      if (externalReadinessProbe === probe) externalReadinessProbe = null;
    }
    if (!healthy || probe.signal.aborted) return;
    if (
      state.isShuttingDown
      || !state.isExternalOpenCode
      || state.isOpenCodeReady
      || state.openCodeBaseUrl !== endpointBefore.baseUrl
      || state.openCodePort !== endpointBefore.port
    ) {
      stopExternalReadinessRecheck();
      return;
    }
    state.openCodeBaseUrl = probeOrigin ?? null;
    setOpenCodePort(probePort);
    state.isOpenCodeReady = true;
    state.lastOpenCodeError = null;
    state.openCodeNotReadySince = 0;
    diagnosticJournal.record('external connected');
    syncToHmrState();
    stopExternalReadinessRecheck();
  };

  const scheduleExternalReadinessRecheck = () => {
    if (externalReadinessTimer || state.isShuttingDown) return;
    externalReadinessTimer = setInterval(() => {
      void recheckExternalReadiness().catch(() => {});
    }, EXTERNAL_READINESS_RECHECK_MS);
    externalReadinessTimer.unref?.();
  };

  const bootstrapOpenCodeAtStartup = async () => {
    const bootstrapStartedAt = performance.now();
    const bootstrapError: LifecycleFailure = { cause: null };
    let unsupportedExternalVersion = null;
    recordStartupPerformance('opencode.bootstrap.start');
    try {
      try {
        const orphanReapStartedAt = performance.now();
        const { reaped } = await reapManagedOrphanedProcesses({ log: (msg: string) => console.log(msg) });
        recordStartupPerformance('opencode.orphan-reap.ready', {
          durationMs: performance.now() - orphanReapStartedAt,
          totalDurationMs: performance.now() - bootstrapStartedAt,
        });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', optionalErrorFields(error)?.message ?? error);
      }

      syncFromHmrState();
      const markExternalConnected = (message: string) => {
        console.log(message);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        if (env.ENV_EFFECTIVE_PORT) setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true; state.isExternalOpenCode = true;
        diagnosticJournal.record('external connected');
        state.lastOpenCodeError = null; state.openCodeNotReadySince = 0; syncToHmrState();
      };
      if (await isOpenCodeProcessHealthy()) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        markExternalConnected(`Using external OpenCode server at ${env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? `http://localhost:${env.ENV_EFFECTIVE_PORT}`} (skip-start mode)`);
      } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        markExternalConnected(`Auto-detected existing OpenCode server at ${env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? `http://localhost:${env.ENV_EFFECTIVE_PORT}`}`);
      } else if (env.ENV_EFFECTIVE_PORT && (unsupportedExternalVersion = await readUnsupportedExternalOpenCodeVersion(
        env.ENV_EFFECTIVE_PORT,
        env.ENV_CONFIGURED_OPENCODE_HOST?.origin,
      ))) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.warn(`OpenCode ${unsupportedExternalVersion} at ${label} is not supported by this OpenChamber`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isExternalOpenCode = true;
        diagnosticJournal.record('external unavailable');
        syncToHmrState();
        throw new UnsupportedOpenCodeVersionError(unsupportedExternalVersion);
      } else if (!env.ENV_EFFECTIVE_PORT && sharedService && await sharedService.isEnabled()) {
        await attachSharedService(sharedService, sharedServiceTarget()); connectedViaSharedService = true;
      } else {
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.openCodeProcess = await startOpenCode();
        syncToHmrState();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        bootstrapError.cause = error;
        if (state.isExternalOpenCode) diagnosticJournal.record('external unavailable');
        state.isOpenCodeReady = false;
        console.error(`OpenCode readiness check failed: ${errorFields(error).message}`);
        if (state.isExternalOpenCode) scheduleExternalReadinessRecheck();
      }
    } catch (error) {
      bootstrapError.cause = error;
      console.error(`Failed to start OpenCode: ${errorFields(error).message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = errorFields(error).message;
    }
    lastBootstrapError.cause = bootstrapError.cause;
    diagnosticJournal.record(bootstrapError.cause ? 'bootstrap failed' : 'bootstrap ready');
    recordStartupPerformance(
      bootstrapError.cause ? 'opencode.bootstrap.error' : 'opencode.bootstrap.ready',
      {
        totalDurationMs: performance.now() - bootstrapStartedAt,
        outcome: bootstrapError.cause ? 'error' : 'ready',
      },
    );
    if (!bootstrapError.cause) {
      bootstrapRetryCount = 0;
      void warmOpenCodeDirectories();
    }
  };

  const runBootstrapRetry = async (bootstrap: () => Promise<void>, onAlreadyRunning: () => void) => {
    while (state.currentRestartPromise) await state.currentRestartPromise.catch(() => {});
    if (state.isShuttingDown) return;
    if (state.openCodeProcess) {
      lastBootstrapError.cause = null;
      onAlreadyRunning();
      return;
    }
    bootstrapRetryRun = bootstrap()
      .catch((error) => console.error(`OpenCode startup retry failed: ${optionalErrorFields(error)?.message ?? error}`))
      .finally(() => {
        bootstrapRetryRun = null;
      });
  };

  const scheduleBootstrapRetry = (bootstrap: () => Promise<void>, onAlreadyRunning: () => void) => {
    if (
      !lastBootstrapError.cause
      || isBinaryRejected(lastBootstrapError.cause)
      || state.openCodeProcess
      || state.isExternalOpenCode
      || state.isShuttingDown
    ) {
      return false;
    }
    const delayMs = BOOTSTRAP_RETRY_DELAYS_MS[Math.min(bootstrapRetryCount, BOOTSTRAP_RETRY_DELAYS_MS.length - 1)];
    bootstrapRetryCount += 1;
    console.log(`Retrying OpenCode startup in ${Number(delayMs) / 1000}s...`);
    setTimeout(() => void runBootstrapRetry(bootstrap, onAlreadyRunning), delayMs).unref?.();
    return true;
  };

  const defaultDirectory = createDefaultDirectory({ getWarmupDirectories: () => getWarmupDirectories(), noProjectDirectory, now });

  const warmOpenCodeDirectories = async () => {
    const directories = await defaultDirectory.warm();

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (!directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        const url = buildOpenCodeUrl('/api/location', '');
        await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-opencode-directory': encodeURIComponent(directory),
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });
      } catch {
        void 0;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let lastCountedHealthFailureAt = 0;
  let healthProbePromise: Promise<OpenCodeHealthProbeResult> | null = null;
  let healthCheckCyclePromise: Promise<void> | null = null;
  let lastHealthProbeResult: OpenCodeHealthProbeResult | null = null;
  let healthFailureCountIntervalMs = 15_000;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
    lastCountedHealthFailureAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const checkedAt = now();
    if (lastHealthProbeResult && checkedAt - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = probeOpenCodeHealthDetailed()
      .then((result) => {
        lastHealthProbeResult = { at: now(), ...result };
        return lastHealthProbeResult;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: false };
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return { skip: true, staleBusy: false };
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: true };
    }

    return { skip: true, staleBusy: false };
  };

  const runHealthCheckCycle = async (source: string) => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthResult = await probeOpenCodeHealth();
      if (!healthResult.healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode(`${source}-process-exited`);
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        const healthFailure = healthResult.failure || {
          class: 'error',
          detail: 'Health check failed without diagnostic detail',
        };
        state.lastOpenCodeHealthFailure = {
          class: healthFailure.class,
          detail: healthFailure.detail,
          at: new Date(checkedAt).toISOString(),
          source,
        };
        diagnosticJournal.record('health failed', { failureClass: healthFailure.class });
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES}) class=${healthFailure.class}`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        const busyDecision = shouldSkipRestartForBusySessions();
        if (busyDecision.skip) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode(
          busyDecision.staleBusy
            ? `${source}-stale-busy-health-failure`
            : `${source}-health-failure`,
        );
      } else {
        if (consecutiveHealthFailures) diagnosticJournal.record('health recovered');
        resetHealthFailureState();
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${errorFields(error).message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs: number) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;
    healthFailureCountIntervalMs = effectiveIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${errorFields(error).message}`);
      }
    }, effectiveIntervalMs);
  };

  return {
    isConnectedViaSharedService: () => connectedViaSharedService,
    getManagedOpenCodeProcessEnv: () => (state.isExternalOpenCode ? null : managedProcessEnv),
    getDefaultOpenCodeDirectory: defaultDirectory.get,
    noteCurrentDirectory: defaultDirectory.note,
    getManagedOpenCodePreflight: async () => {
      const preflight = managedPreflight;
      if (!preflight || state.isExternalOpenCode || state.isShuttingDown) return false;
      const compatible = await preflight;
      return compatible && preflight === managedPreflight && !state.isExternalOpenCode && !state.isShuttingDown;
    },
    killProcessOnPort,
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    scheduleBootstrapRetry,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
  };
};
