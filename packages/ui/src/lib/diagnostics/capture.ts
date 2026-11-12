import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { canUseElectronDesktopIPC, isDesktopLocalOriginActive, isVSCodeRuntime } from '@/lib/desktop';
import { z } from 'zod';
import { clearDiagnosticEvents, diagnosticIdentity, recordDiagnosticEvent, type DiagnosticEvent, recordRendererConsole, rendererErrorDetail, rendererRejectionDetail } from './timeline';

type Status = { initialized: boolean; connected: boolean; stream: string; session: boolean; directory: boolean };
export type DiagnosticHealthSample = {
  at: number;
  http: number;
  running: boolean | 'unknown';
  ready: boolean | 'unknown';
  secure: boolean | 'unknown';
  port: number | null;
  wsl: boolean | 'unknown';
  binarySource: string;
  wrapper: string;
  lastError: string | null;
};
const healthSchema = z.object({
  openCodeRunning: z.boolean().optional(),
  isOpenCodeReady: z.boolean().optional(),
  openCodeSecureConnection: z.boolean().optional(),
  openCodePort: z.number().int().min(1).max(65535).optional(),
  opencodeViaWsl: z.boolean().optional(),
  opencodeBinarySource: z.enum(['bundled', 'env', 'path', 'fallback', 'where', 'shell', 'policy', 'settings', 'wsl', 'unknown']).nullish().catch(null),
  opencodeLaunchWrapperType: z.enum(['bun-shebang', 'cmd-wrapper', 'node-launcher', 'node-shebang']).nullish().catch(null),
  lastOpenCodeError: z.string().nullish().catch(null),
}).refine((health) => health.openCodeRunning !== undefined && health.isOpenCodeReady !== undefined);
const healthFailureSchema = z.object({
  lastOpenCodeHealthFailure: z.object({
    at: z.iso.datetime(),
    class: z.enum(['timeout', 'connection_refused', 'connection_reset', 'invalid_response', 'error']),
  }).nullish(),
});
const launchSchema = z.object({
  lastOpenCodeLaunchDiagnostics: z.object({
    launchedAt: z.iso.datetime(),
    hasShellEnv: z.boolean().optional(),
    pathEntryCount: z.number().int().nonnegative().optional(),
  }).nullish(),
});
const processSchema = z.object({
  lastManagedOpenCodeProcess: z.object({
    pid: z.number().int().positive().nullish(),
    exitCode: z.number().int().nullish(),
    signalCode: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGHUP', 'SIGSEGV']).nullish().catch(null),
  }).nullish(),
});
const restartSchema = z.object({
  lastOpenCodeRestartDiagnostics: z.object({
    at: z.iso.datetime(),
    busySessionCount: z.number().int().nonnegative().optional(),
  }).nullish(),
});
// The startup error text can carry paths and process output; only its kind
// may enter the export. The full text stays on the startup screen.
const START_ERROR_CLASSES: [RegExp, string][] = [
  [/^OpenCode process exited before serving with code (-?\d{1,5})\b/, 'exited before serving (code $1)'],
  [/^OpenCode process exited before serving with signal ([A-Z]{3,10})\b/, 'exited before serving (signal $1)'],
  [/^Timeout waiting for OpenCode to start\b/, 'start timed out'],
  [/^Timed out waiting for OpenCode (?:port|to become ready)\b/, 'readiness timed out'],
  [/^Server started but health check failed\b/, 'health check failed after start'],
  [/^External OpenCode server on port \d{1,5} is not responding$/, 'external server not responding'],
  [/did not identify itself as OpenCode 2\.x/, 'server is not OpenCode 2.x'],
  [/through WSL is no longer supported/, 'WSL launch unsupported'],
  [/\bENOENT\b/, 'binary not found'],
  [/\bEACCES\b/, 'binary not executable'],
];

export function classifyStartError(message: string): string {
  for (const [pattern, label] of START_ERROR_CLASSES) {
    const match = pattern.exec(message);
    if (match) return label.replace('$1', match[1] ?? '');
  }
  return 'unclassified';
}

let lastHealthFailureAt = '';
let lastLaunchAt = '';
let lastRestartAt = '';

export function isLocalDiagnosticRuntime(): boolean {
  if (canUseElectronDesktopIPC()) return isDesktopLocalOriginActive();
  if (isVSCodeRuntime()) return false;
  try {
    const endpoint = new URL(getRuntimeUrlResolver().api('/api/info'), window.location.href);
    const local = new URL(window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin);
    return endpoint.origin === local.origin && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  } catch {
    return false;
  }
}

const status = (): Status => ({
  initialized: useConfigStore.getState().isInitialized,
  connected: useConfigStore.getState().isConnected,
  stream: useUIStore.getState().eventStreamStatus,
  session: Boolean(useSessionUIStore.getState().currentSessionId),
  directory: Boolean(useDirectoryStore.getState().currentDirectory),
});

/**
 * Console capture wraps `console.*`, so DevTools would attribute every log to
 * this file. Development builds leave the console alone to keep call sites.
 */
export function startDiagnosticCapture({ captureConsole = !import.meta.env.DEV }: { captureConsole?: boolean } = {}): () => void {
  let previous = status();
  let scope = getRuntimeKey();
  let local = isLocalDiagnosticRuntime();
  const snapshot = () => {
    previous = status();
    if (!local) return;
    const at = Date.now();
    recordDiagnosticEvent({ at, source: 'ui', action: 'state snapshot', detail: JSON.stringify(previous) });
    const sessionId = useSessionUIStore.getState().currentSessionId;
    if (sessionId) recordDiagnosticEvent({ at, source: 'ui', action: 'session selection snapshot', detail: diagnosticIdentity('session', sessionId) });
    const directory = useDirectoryStore.getState().currentDirectory;
    if (directory) recordDiagnosticEvent({ at, source: 'ui', action: 'directory selection snapshot', detail: diagnosticIdentity('directory', directory) });
    void sampleServerHealth();
  };
  snapshot();
  const update = (field: keyof Status, value: boolean | string) => {
    if (!local) return;
    if (previous[field] === value) return;
    previous = { ...previous, [field]: value };
    recordDiagnosticEvent({ at: Date.now(), source: 'ui', action: `${field} changed`, detail: String(value) });
  };
  const selectionChanged = (kind: 'session' | 'directory', from: string | null, to: string | null) => {
    if (!local) return;
    previous = { ...previous, [kind]: Boolean(to) };
    recordDiagnosticEvent({
      at: Date.now(), source: 'ui', action: `${kind} changed`,
      detail: `from=${from ? diagnosticIdentity(kind, from) : 'none'} to=${to ? diagnosticIdentity(kind, to) : 'none'}`,
    });
  };
  const unsubscribers = [
    useConfigStore.subscribe((next, prev) => {
      if (next.isInitialized !== prev.isInitialized) update('initialized', next.isInitialized);
      if (next.isConnected !== prev.isConnected) update('connected', next.isConnected);
    }),
    useUIStore.subscribe((next, prev) => {
      if (next.eventStreamStatus !== prev.eventStreamStatus) update('stream', next.eventStreamStatus);
    }),
    useSessionUIStore.subscribe((next, prev) => {
      if (next.currentSessionId !== prev.currentSessionId) selectionChanged('session', prev.currentSessionId, next.currentSessionId);
    }),
    useDirectoryStore.subscribe((next, prev) => {
      if (next.currentDirectory !== prev.currentDirectory) selectionChanged('directory', prev.currentDirectory, next.currentDirectory);
    }),
  ];
  const stopRuntime = subscribeRuntimeEndpointChanged(() => {
    if (getRuntimeKey() === scope) return;
    scope = getRuntimeKey();
    clearDiagnosticEvents();
    local = isLocalDiagnosticRuntime();
    lastHealthFailureAt = '';
    lastLaunchAt = '';
    lastRestartAt = '';
    snapshot();
  });
  const consoleMethods = (captureConsole ? (['debug', 'info', 'log', 'warn', 'error'] as const) : []).map((level) => {
    const original = console[level];
    const wrapped: typeof original = (...args) => {
      if (local) {
        const first = z.string().safeParse(args[0]);
        const error = level === 'warn' || level === 'error' ? args.find((arg) => arg instanceof Error) : undefined;
        recordRendererConsole(level, first.success ? first.data : '', error);
      }
      original.apply(console, args);
    };
    console[level] = wrapped;
    return () => { if (console[level] === wrapped) console[level] = original; };
  });
  const onError = (event: Event) => {
    if (!local) return;
    recordDiagnosticEvent({
      at: Date.now(), source: 'renderer', action: event instanceof ErrorEvent ? 'uncaught exception' : 'resource error',
      detail: event instanceof ErrorEvent ? rendererErrorDetail(event, window.location.href) : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!local) return;
    recordDiagnosticEvent({ at: Date.now(), source: 'renderer', action: 'unhandled rejection', detail: rendererRejectionDetail(event.reason instanceof Error ? event.reason : null) });
  };
  const onPolicyViolation = () => { if (local) recordDiagnosticEvent({ at: Date.now(), source: 'renderer', action: 'content security policy violation' }); };
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('securitypolicyviolation', onPolicyViolation);
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    stopRuntime();
    consoleMethods.forEach((restore) => restore());
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('securitypolicyviolation', onPolicyViolation);
  };
}

/** Samples the local instance into the shared timeline buffer. */
export async function sampleServerHealth(): Promise<DiagnosticHealthSample | null> {
  if (!isLocalDiagnosticRuntime()) return null;
  return readServerHealth(recordDiagnosticEvent, { repeatHistory: false });
}

/**
 * Reads the active runtime's `/health` and reports what it saw through `emit`.
 * A remote export collects into its own list and wants the server's history
 * every time; the local buffer has seen earlier samples and skips repeats.
 */
export async function readServerHealth(
  emit: (event: DiagnosticEvent) => void,
  { repeatHistory }: { repeatHistory: boolean },
): Promise<DiagnosticHealthSample | null> {
  const scope = getRuntimeKey();
  const url = getRuntimeUrlResolver().health();
  if (!url) return null;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await runtimeFetch(url, { signal: controller.signal });
    if (getRuntimeKey() !== scope) return null;
    if (!response.ok) {
      emit({ at: Date.now(), source: 'server', action: 'health probe', detail: `http=${response.status} timeMs=${Date.now() - startedAt}` });
      return null;
    }
    const raw = await response.json();
    const parsed = healthSchema.safeParse(raw);
    if (getRuntimeKey() !== scope) return null;
    if (!parsed.success) {
      emit({ at: Date.now(), source: 'server', action: 'health response invalid' });
      return null;
    }
    const health = parsed.data;
    // Fixed values only. Binary paths, process stderr and auth diagnostics can
    // contain private data; the last startup error enters only as its class.
    const sample: DiagnosticHealthSample = {
      at: Date.now(), http: response.status,
      running: health.openCodeRunning ?? 'unknown', ready: health.isOpenCodeReady ?? 'unknown',
      secure: health.openCodeSecureConnection ?? 'unknown', port: health.openCodePort ?? null,
      wsl: health.opencodeViaWsl ?? 'unknown',
      binarySource: health.opencodeBinarySource ?? 'unknown',
      wrapper: health.opencodeLaunchWrapperType ?? 'none',
      lastError: health.lastOpenCodeError ? classifyStartError(health.lastOpenCodeError) : null,
    };
    emit({
      at: sample.at, source: 'server', action: 'health probe',
      detail: `http=${sample.http} timeMs=${sample.at - startedAt} running=${sample.running} ready=${sample.ready} secure=${sample.secure} port=${sample.port ?? 'unknown'} wsl=${sample.wsl}`,
    });
    const processResult = processSchema.safeParse(raw);
    const managedProcess = processResult.success ? processResult.data.lastManagedOpenCodeProcess : null;
    if (managedProcess) {
      const { pid, exitCode, signalCode } = managedProcess;
      emit({
        at: Date.now(), source: 'OpenCode process', action: 'process snapshot',
        detail: `pid=${pid ?? 'none'} exit=${exitCode ?? 'running'} signal=${signalCode ?? 'none'}`,
      });
    }
    const failureResult = healthFailureSchema.safeParse(raw);
    const failure = failureResult.success ? failureResult.data.lastOpenCodeHealthFailure : null;
    if (failure && (repeatHistory || lastHealthFailureAt !== failure.at)) {
      if (!repeatHistory) lastHealthFailureAt = failure.at;
      emit({ at: Date.parse(failure.at), source: 'OpenCode process', action: `health failed: ${failure.class}` });
    }
    const launchResult = launchSchema.safeParse(raw);
    const launch = launchResult.success ? launchResult.data.lastOpenCodeLaunchDiagnostics : null;
    if (launch && (repeatHistory || lastLaunchAt !== launch.launchedAt)) {
      if (!repeatHistory) lastLaunchAt = launch.launchedAt;
      emit({
        at: Date.parse(launch.launchedAt), source: 'OpenCode process', action: 'managed launch',
        detail: `shellEnv=${launch.hasShellEnv ?? 'unknown'} pathEntries=${launch.pathEntryCount ?? 'unknown'}`,
      });
    }
    const restartResult = restartSchema.safeParse(raw);
    const restart = restartResult.success ? restartResult.data.lastOpenCodeRestartDiagnostics : null;
    if (restart && (repeatHistory || lastRestartAt !== restart.at)) {
      if (!repeatHistory) lastRestartAt = restart.at;
      emit({
        at: Date.parse(restart.at), source: 'OpenCode process', action: 'managed restart',
        detail: `busySessions=${restart.busySessionCount ?? 'unknown'}`,
      });
    }
    return sample;
  } catch {
    if (getRuntimeKey() === scope) emit({ at: Date.now(), source: 'server', action: 'health probe failed' });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
