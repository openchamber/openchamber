import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { terminalPlainText } from './plain-text.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { buildTerminalShellLaunch, createTerminalShellResolver, normalizeTerminalShell } from './shells.js';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv, resolvePosixPtyLaunch } from '../inherited-env.js';
import { shutdownTerminalProcesses } from './shutdown.js';
import { bunVersionRunsBunPty } from './bun-pty-support.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';
import { isString as isText } from '../shared/object-guards.js';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Stats } from 'node:fs';
import type * as nodePath from 'node:path';
import type { IWindowsPtyForkOptions, IPtyForkOptions } from 'node-pty';
import type { Application } from '../shared/http-contracts.js';
import type { WebSocket, WebSocketServer as TerminalWebSocketServer } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createEnvironmentRuntime } from '../environment/runtime.js';
import type { TerminalShellResolverOptions, TerminalShellPreference, TerminalLaunchMode, TerminalShellLaunchOptions } from './shells.js';
import type { TerminalHistoryPending } from './history.js';
import type { TerminalThemeMode } from './theme-response.js';
import type { TerminalWsFrameOptions, TerminalWsJsonObject, TerminalWsJsonValue } from './terminal-ws-protocol.js';

export type TerminalPurpose = { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };
type TerminalStatus = 'running' | 'exited';
type TerminalBackend = 'bun-pty' | 'node-pty';
type PtyOptions = IPtyForkOptions & IWindowsPtyForkOptions;
type PtyExit = { exitCode: number; signal?: number | string | undefined };
type Disposable = { dispose(): void };

interface TerminalPty {
  pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExit) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalPtyModule {
  spawn(executable: string, args: string[], options: PtyOptions): TerminalPty | Promise<TerminalPty>;
}

export interface TerminalPtyProvider extends TerminalPtyModule {
  backend: TerminalBackend;
}

export interface TerminalRuntimeOptions extends Pick<TerminalShellResolverOptions, 'searchPathFor' | 'isExecutable'> {
  app: Pick<Application, 'get' | 'post' | 'delete'>;
  server: Pick<Server, 'on' | 'off'>;
  fs: { promises: TerminalShellResolverOptions['fs']['promises'] & { stat(cwd: string): Promise<Pick<Stats, 'isDirectory'>> } };
  path: Pick<typeof nodePath, 'join' | 'resolve'>;
  uiAuthController?: Pick<ReturnType<typeof createUiAuth>, 'enabled' | 'ensureSessionToken'> | null;
  buildAugmentedPath: () => string;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade(socket: Duplex, code: number, reason: string): void;
  TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: number;
  loadPtyProvider?: () => TerminalPtyProvider | Promise<TerminalPtyProvider>;
  terminalTerminationGraceMs?: number;
  shutdownProcesses?: typeof shutdownTerminalProcesses;
  environmentRuntime?: Pick<ReturnType<typeof createEnvironmentRuntime>, 'applyToDirectory'> | null;
  broadcastUiEvent?: (event: { type: 'openchamber:terminal-sessions-changed'; properties: object }) => void;
  logger?: { warn?: typeof console.warn };
}

interface TerminalAppearanceInput {
  themeMode?: unknown;
  terminalBackground?: unknown;
  terminalForeground?: unknown;
}

interface TerminalRequestFields extends TerminalAppearanceInput {
  cwd?: unknown;
  sessionId?: unknown;
  sessionIds?: unknown;
  cols?: unknown;
  rows?: unknown;
  shell?: unknown;
  loginShell?: unknown;
  mode?: unknown;
  command?: unknown;
  purpose?: unknown;
}

interface TerminalErrorBody {
  error: unknown;
  code?: string;
}

interface TerminalSpawnOptions extends Pick<TerminalShellLaunchOptions, 'mode' | 'command'> {
  cwd: string;
  cols: number;
  rows: number;
  themeMode: unknown;
  shell: unknown;
  loginShell: boolean;
}

interface TerminalStartOptions extends Omit<TerminalSpawnOptions, 'cwd' | 'themeMode'>, TerminalAppearanceInput {
  cwd: unknown;
  purpose?: TerminalPurpose;
}

interface TerminalHistory {
  chunks: { buffer: Buffer; length: number }[];
  head: number;
  offset: number;
  bytes: number;
  original: string[] | null;
  originalTail: string;
  originalLast: string | undefined;
}

type PtyEvent = ({ type: 'output'; data: string } | ({ type: 'exit'; signal: PtyExit['signal'] } & Pick<PtyExit, 'exitCode'>)) & { process: TerminalPty };

interface TerminalSessionSeed {
  id: string;
  sequence: number;
  history: TerminalHistory;
  pendingHistoryControlSequence: TerminalHistoryPending;
  pendingThemeControlSequence: string;
  eventQueue: PtyEvent[];
  draining: boolean;
  createdAt: number;
  outputTimer?: ReturnType<typeof setTimeout> | null;
  pendingOutput?: { raw: string[]; replay: string[]; chars: number } | null;
  themeModeEnabled?: boolean;
}

interface TerminalSession extends TerminalSessionSeed {
  retired: boolean;
  cwd: string;
  cols: number;
  rows: number;
  process: TerminalPty | null;
  backend: TerminalBackend;
  shell: TerminalShellPreference;
  loginShell: boolean;
  shellExecutable: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  mode: TerminalLaunchMode;
  command: string | null;
  purpose: TerminalPurpose;
  themeMode: TerminalThemeMode;
  terminalBackground: unknown;
  terminalForeground: unknown;
  lastActivity: number;
}

export interface TerminalListing {
  sessionId: string;
  cwd: string;
  status: TerminalStatus;
  createdAt: number | null;
  mode: TerminalLaunchMode;
  purpose: TerminalPurpose;
}

export interface TerminalRead extends TerminalListing {
  exitCode: number | null;
  signal: number | null;
  text: string;
  truncated: boolean;
  retainedBytes: number;
}

interface PendingCreate {
  cwd: string;
  shell: TerminalShellPreference;
  loginShell: boolean;
  mode: TerminalLaunchMode;
  command: string | null;
  purpose: TerminalPurpose;
  cancelled: boolean;
  promise: Promise<TerminalSession> | null;
}

const pendingCreatePromise = ({ promise }: PendingCreate) => {
  if (!promise) throw new Error('Missing pending terminal creation');
  return promise;
};

type TerminalEvent = { t: 'output'; d: string; r?: string } | { t: 'exit'; exitCode: number | null; signal: number | null } | { t: 'restarted'; history: string };
type PublishedEvent = TerminalEvent & { v: number; s: string; q: number };
interface Attachment { initializing: boolean; pending: PublishedEvent[] }
interface Connection { socket: WebSocket; attachments: Map<string, Attachment> }

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const DEFAULT_TERMINAL_READ_BYTES = 32 * 1024;
const MAX_TERMINAL_READ_BYTES = 256 * 1024;
const HISTORY_SEGMENT_BYTES = 8 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;
const OUTPUT_BATCH_MS = 12;
const MAX_OUTPUT_BATCH_CHARS = 32 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const INTERACTIVE_TERMINAL_MODE = 'interactive';
const COMMAND_TERMINAL_MODE = 'command';
const TERMINAL_CWD_MISSING_CODE = 'TERMINAL_CWD_MISSING';
const TERMINAL_PURPOSE = Object.freeze({ type: 'terminal' });
const MAX_PURPOSE_ID_CHARS = 128;
const OBJECT_TAG = '[object Object]';
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const validateSize = (value: unknown, max: number): value is number => isInteger(value) && value >= 1 && value <= max;
const isString = (value: unknown): value is string => String(value) === value;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const hasRequestFields = (value: unknown): value is TerminalRequestFields => value != null;
const hasErrorFields = (value: unknown): value is { message?: unknown; code?: unknown } => value != null;
type DecodedFrame = TerminalWsJsonObject | TerminalWsJsonValue[];
const hasFrameFields = (value: DecodedFrame | null): value is DecodedFrame & { v?: unknown; t?: unknown; s?: unknown; z?: unknown; d?: unknown } => value !== null;
const isObjectRecord = (value: unknown): value is { type?: unknown; actionId?: unknown; executionId?: unknown } => value != null && !Array.isArray(value) && Object.prototype.toString.call(value) === OBJECT_TAG;
type CreateMode = { mode: 'interactive'; command: null } | { mode: 'command'; command: string };
const normalizeCreateMode = ({ mode, command }: Pick<TerminalRequestFields, 'mode' | 'command'>): CreateMode => {
  const normalizedMode = mode == null ? INTERACTIVE_TERMINAL_MODE : mode;
  if (normalizedMode !== INTERACTIVE_TERMINAL_MODE && normalizedMode !== COMMAND_TERMINAL_MODE) throw new Error('Invalid terminal mode');
  if (normalizedMode === INTERACTIVE_TERMINAL_MODE) {
    if (command != null) throw new Error('Interactive terminal create does not accept a command');
    return { mode: INTERACTIVE_TERMINAL_MODE, command: null };
  }
  if (!isString(command) || !command.trim()) throw new Error('Terminal command is required');
  const trimmedCommand = command.trim();
  if (trimmedCommand.length > MAX_INPUT_CHARS) throw new Error('Terminal command exceeds the input limit');
  return { mode: COMMAND_TERMINAL_MODE, command: trimmedCommand };
};
const normalizePurposeId = (value: string, errorMessage: string) => {
  if (!value.trim()) throw new Error(errorMessage);
  const normalized = value.trim();
  if (normalized.length > MAX_PURPOSE_ID_CHARS) throw new Error(errorMessage);
  return normalized;
};
const normalizeTerminalPurpose = ({ purpose: value }: Pick<TerminalRequestFields, 'purpose'>): TerminalPurpose => {
  if (value == null) return TERMINAL_PURPOSE;
  if (!isObjectRecord(value)) throw new Error('Invalid terminal purpose');
  if (value.type === 'terminal') return TERMINAL_PURPOSE;
  if (value.type !== 'project-action') throw new Error('Invalid terminal purpose');
  const actionIdError = 'Terminal project action id is required';
  const executionIdError = 'Terminal execution id is required';
  const rawActionId = value.actionId;
  if (!isString(rawActionId)) throw new Error(actionIdError);
  const actionId = normalizePurposeId(rawActionId, actionIdError);
  const rawExecutionId = value.executionId;
  if (!isString(rawExecutionId)) throw new Error(executionIdError);
  const executionId = normalizePurposeId(rawExecutionId, executionIdError);
  return { type: 'project-action', actionId, executionId };
};
const getSessionPurpose = (session: TerminalSession) => session.purpose ?? TERMINAL_PURPOSE;
const isPurposeActionMatch = (left: TerminalPurpose, right: TerminalPurpose) => {
  if (left.type !== right.type) return false;
  return left.type !== 'project-action' || (right.type === 'project-action' && left.actionId === right.actionId);
};
const findRunningActionSession = (sessions: Map<string, TerminalSession>, resolvedCwd: string, purpose: TerminalPurpose, path: TerminalRuntimeOptions['path']) => {
  if (purpose.type !== 'project-action') return null;
  for (const session of sessions.values()) {
    if (session.status !== 'running') continue;
    if (path.resolve(session.cwd) !== resolvedCwd) continue;
    const sessionPurpose = getSessionPurpose(session);
    if (sessionPurpose.type === 'project-action' && sessionPurpose.actionId === purpose.actionId) return session;
  }
  return null;
};
const findPendingActionCreate = (pendingSessionCreates: Map<string, PendingCreate>, resolvedCwd: string, purpose: TerminalPurpose) => {
  if (purpose.type !== 'project-action') return null;
  for (const pending of pendingSessionCreates.values()) {
    if (pending.cancelled || pending.cwd !== resolvedCwd) continue;
    if (pending.purpose?.type === 'project-action' && pending.purpose.actionId === purpose.actionId) return pending;
  }
  return null;
};
const newHistory = (): TerminalHistory => ({ chunks: [], head: 0, offset: 0, bytes: 0, original: [], originalTail: '', originalLast: '' });
const historyText = (history: TerminalHistory) => history.original
  ? history.original.join('') + history.originalTail
  : Buffer.concat(history.chunks.slice(history.head).map((chunk, index) => chunk.buffer.subarray(index === 0 ? history.offset : 0, chunk.length))).toString('utf8');
const appendHistoryBytes = (history: TerminalHistory, bytes: Buffer) => {
  let offset = 0;
  while (offset < bytes.length) {
    let tail = history.chunks.at(-1);
    if (!tail || tail.length === HISTORY_SEGMENT_BYTES) {
      tail = { buffer: Buffer.allocUnsafe(HISTORY_SEGMENT_BYTES), length: 0 };
      history.chunks.push(tail);
    }
    const length = Math.min(bytes.length - offset, HISTORY_SEGMENT_BYTES - tail.length);
    bytes.copy(tail.buffer, tail.length, offset, offset + length);
    tail.length += length;
    offset += length;
  }
  history.bytes += bytes.length;
};
const removeHistoryTail = (history: TerminalHistory, count: number) => {
  history.bytes -= count;
  while (count > 0) {
    const tail = history.chunks.at(-1);
    if (!tail) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    const removed = Math.min(tail.length, count);
    tail.length -= removed;
    count -= removed;
    if (!tail.length) history.chunks.pop();
  }
};
const appendOriginal = (history: TerminalHistory, original: string[], text: string) => {
  let offset = 0;
  while (offset < text.length) {
    const length = Math.min(text.length - offset, HISTORY_SEGMENT_BYTES - history.originalTail.length);
    history.originalTail += text.slice(offset, offset + length);
    offset += length;
    if (history.originalTail.length === HISTORY_SEGMENT_BYTES) {
      original.push(history.originalTail);
      history.originalTail = '';
    }
  }
  history.originalLast = text.at(-1);
};
const appendHistory = (history: TerminalHistory, text: string) => {
  if (!text) return;
  let encoded = text;
  if (history.original && /[\uD800-\uDBFF]/.test(String(history.originalLast)) && /^[\uDC00-\uDFFF]/.test(text)) {
    removeHistoryTail(history, 3);
    encoded = history.originalLast + text;
  }
  const bytes = Buffer.from(encoded);
  if (history.bytes + bytes.length <= MAX_HISTORY_BYTES) {
    appendHistoryBytes(history, bytes);
    if (history.original) appendOriginal(history, history.original, text);
    return;
  }

  if (bytes.length >= MAX_HISTORY_BYTES) {
    let start = bytes.length - MAX_HISTORY_BYTES;
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    history.chunks = []; history.head = 0; history.offset = 0; history.bytes = 0;
    appendHistoryBytes(history, bytes.subarray(start));
    history.original = null;
    history.originalTail = '';
    return;
  }

  appendHistoryBytes(history, bytes);

  let remove = history.bytes - MAX_HISTORY_BYTES;
  let removed = 0;
  while (remove > 0) {
    const chunk = history.chunks[history.head];
    if (!chunk) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    const available = chunk.length - history.offset;
    if (remove < available) { history.offset += remove; removed += remove; break; }
    remove -= available;
    removed += available;
    history.head += 1;
    history.offset = 0;
  }
  while (history.head < history.chunks.length) {
    const chunk = history.chunks[history.head];
    if (!chunk) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    if (history.offset === chunk.length) { history.head += 1; history.offset = 0; continue; }
    if (((chunk.buffer[history.offset] ?? 0) & 0xc0) !== 0x80) break;
    history.offset += 1;
    removed += 1;
  }
  history.bytes -= removed;
  history.original = null;
  history.originalTail = '';
  if (history.head > 128) { history.chunks = history.chunks.slice(history.head); history.head = 0; }
};

export async function loadTerminalPtyProvider(
  bunVersion: string | null | undefined = globalThis.Bun?.version,
  importPty: (name: TerminalBackend) => Promise<TerminalPtyModule> = (name) => name === 'bun-pty' ? import('bun-pty') : import('node-pty'),
): Promise<TerminalPtyProvider> {
  if (bunVersionRunsBunPty(bunVersion)) {
    try { const pty = await importPty('bun-pty'); return { spawn: pty.spawn, backend: 'bun-pty' }; } catch { void 0; }
  }
  const pty = await importPty('node-pty');
  return { spawn: pty.spawn, backend: 'node-pty' };
}

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, terminalTerminationGraceMs = TERMINATION_GRACE_MS, shutdownProcesses = shutdownTerminalProcesses,
  environmentRuntime = null,
  broadcastUiEvent = () => {},
  logger = console,
}: TerminalRuntimeOptions) {
  const sessions = new Map<string, TerminalSession>();
  const announceSessionsChanged = () => broadcastUiEvent({ type: 'openchamber:terminal-sessions-changed', properties: {} });
  const pendingSessionCreates = new Map<string, PendingCreate>();
  const pendingSessionRestarts = new Map<string, Promise<void>>();
  const connections = new Set<Connection>();
  const pendingTerminations = new Set<Promise<void>>();
  const runtime = globalThis.Bun === undefined ? 'node' : 'bun';
  let ptyProviderPromise: TerminalPtyProvider | Promise<TerminalPtyProvider> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let wsServer: TerminalWebSocketServer | null = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });

  const getPtyProvider = async () => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = (loadPtyProvider ?? loadTerminalPtyProvider)();
    }
    return ptyProviderPromise;
  };

  const spawnPty = async ({ cwd, cols, rows, themeMode, shell, loginShell, mode, command }: TerminalSpawnOptions) => {
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell == null || isText(shell) ? shell : '');
    const hostEnv = { ...process.env, PATH: buildAugmentedPath() };
    const inheritedEnv = environmentRuntime ? await environmentRuntime.applyToDirectory(cwd, hostEnv, { refresh: true }) : hostEnv;
    let lastError = null;
    for (const executable of resolvedShell.executables) {
      try {
        const env: NodeJS.ProcessEnv = { ...inheritedEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        delete env.NODE_CHANNEL_FD;
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        stripAppImageArgv0Leak(env);
        stripAppImageLauncherEnv(env);
        const shellLaunch = buildTerminalShellLaunch(executable, { mode, command, loginShell });
        const launch = resolvePosixPtyLaunch(shellLaunch.executable, shellLaunch.args);
        const options: PtyOptions = { name: 'xterm-256color', cwd, cols, rows, env };
        if (process.platform === 'win32') options.useConpty = true;
        return { process: await provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, shellExecutable: executable, loginShell };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess: TerminalPty | null, force = false) => {
    if (!ptyProcess) return;
    if (process.platform !== 'win32' && Number.isInteger(ptyProcess.pid) && ptyProcess.pid > 0) {
      try { process.kill(-ptyProcess.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { void 0; }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { return; }
  };

  const terminateProcess = (ptyProcess: TerminalPty | null, force = false) => {
    if (!ptyProcess) return Promise.resolve();
    if (force) { killProcess(ptyProcess, true); return Promise.resolve(); }
    const termination = new Promise<void>((resolve) => {
      let settled = false;
      let disposable: Disposable | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        resolve();
      };
      const timeout = setTimeout(() => { killProcess(ptyProcess, true); finish(); }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); } catch { disposable = null; }
      killProcess(ptyProcess, false);
    }).finally(() => { pendingTerminations.delete(termination); });
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket: WebSocket, message: TerminalWsJsonObject, frameOptions?: TerminalWsFrameOptions) => {
    if (socket?.readyState !== 1) return false;
    try {
      const frame = createTerminalWsControlFrame(message, frameOptions);
      if (socket.bufferedAmount + frame.length > MAX_SOCKET_BUFFER_BYTES) {
        socket.terminate();
        return false;
      }
      socket.send(frame, { binary: true });
      return true;
    } catch { return false; }
  };

  const flushOutput = (session: TerminalSession) => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    const output = session.pendingOutput;
    if (!output) return;
    session.pendingOutput = null;
    const raw = output.raw.join('');
    const replay = output.replay.join('');
    const event: Extract<TerminalEvent, { t: 'output' }> = { t: 'output', d: raw };
    if (raw !== replay) event.r = replay;
    publish(session, event);
  };

  const openOutputWindow = (session: TerminalSession) => {
    session.outputTimer = setTimeout(() => {
      session.outputTimer = null;
      if (!session.pendingOutput) return;
      flushOutput(session);
      openOutputWindow(session);
    }, OUTPUT_BATCH_MS);
  };

  const discardOutput = (session: TerminalSessionSeed) => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    session.pendingOutput = null;
  };

  const closeAttachments = (sessionId: string, code: string, message: string) => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session: TerminalSession) => ({
    t: 'snapshot', v: 3, s: session.id, q: session.sequence, history: historyText(session.history),
    cols: session.cols, rows: session.rows,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    mode: session.mode ?? INTERACTIVE_TERMINAL_MODE, purpose: getSessionPurpose(session),
    runtime, ptyBackend: session.backend,
  });

  const publish = (session: TerminalSession, event: TerminalEvent) => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const drainEvents = (session: TerminalSession) => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (!event) throw new TypeError("Cannot read properties of undefined (reading 'process')");
        if (session.retired || event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          }, { respondToPrimaryDeviceAttributes: true });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) session.process?.write(response);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          appendHistory(session.history, sanitized.visible);
          session.lastActivity = Date.now();
          const output = session.pendingOutput ??= { raw: [], replay: [], chars: 0 };
          output.raw.push(event.data); output.replay.push(sanitized.visible); output.chars += event.data.length;
          if (output.chars >= MAX_OUTPUT_BATCH_CHARS) flushOutput(session);
          else if (!session.outputTimer) { flushOutput(session); openOutputWindow(session); }
        } else {
          flushOutput(session);
          session.pendingHistoryControlSequence = '';
          session.pendingThemeControlSequence = '';
          session.status = 'exited';
          session.exitCode = isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = isInteger(event.signal) ? event.signal : null;
          session.process = null;
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
          if (sessions.get(session.id) === session) announceSessionsChanged();
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session: TerminalSession, ptyProcess: TerminalPty) => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, exitCode, signal }); drainEvents(session); });
  };

  const invalidWorkingDirectory = (code?: typeof TERMINAL_CWD_MISSING_CODE) => Object.assign(new Error('Invalid working directory'), code ? { code } : {});
  const validateCwd = async ({ cwd }: Pick<TerminalRequestFields, 'cwd'>) => {
    if (!isText(cwd) || !cwd.trim()) throw new Error('cwd is required');
    let stats;
    try { stats = await fs.promises.stat(cwd); }
    catch (error) { throw invalidWorkingDirectory(hasErrorFields(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? TERMINAL_CWD_MISSING_CODE : undefined); }
    if (!stats?.isDirectory()) throw invalidWorkingDirectory();
    return cwd;
  };
  const errorBody = (error: { message?: unknown; code?: unknown } | undefined, fallback: string) => {
    const body: TerminalErrorBody = { error: error?.message || fallback };
    if (isText(error?.code)) body.code = error.code;
    return body;
  };

  const applyAppearance = (session: TerminalSession, { themeMode, terminalBackground, terminalForeground }: TerminalAppearanceInput) => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (isText(terminalBackground)) session.terminalBackground = terminalBackground;
    if (isText(terminalForeground)) session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      try { session.process?.write(terminalThemeModeReport(session.themeMode)); } catch { return; }
    }
  };

  const startSession = async (seed: TerminalSessionSeed, { cwd: requestedCwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell, mode = INTERACTIVE_TERMINAL_MODE, command = null, purpose = TERMINAL_PURPOSE }: TerminalStartOptions, clear = true) => {
    const cwd = await validateCwd({ cwd: requestedCwd });
    const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell, mode, command });
    if (clear) { discardOutput(seed); seed.history = newHistory(); seed.pendingHistoryControlSequence = ''; seed.pendingThemeControlSequence = ''; seed.themeModeEnabled = false; }
    const initialized: Omit<TerminalSession, keyof TerminalSessionSeed | 'lastActivity'> = {
      retired: false, cwd, cols, rows, process: spawned.process,
      backend: spawned.backend, shell: spawned.shell, loginShell: spawned.loginShell, status: 'running', exitCode: null, signal: null,
      shellExecutable: spawned.shellExecutable,
      mode, command: mode === COMMAND_TERMINAL_MODE ? command : null, purpose,
      themeMode: themeMode === 'light' ? 'light' : 'dark', terminalBackground, terminalForeground,
    };
    const session: TerminalSession = Object.assign(seed, initialized, { lastActivity: Date.now() });
    session.eventQueue.length = 0;
    wire(session, spawned.process);
    return { session, ptyProcess: spawned.process };
  };

  const createSession = async ({ sessionId, cwd, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false, mode, command, purpose }: TerminalRequestFields): Promise<TerminalSession> => {
    if (shutdownPromise) throw new Error('Terminal runtime is shutting down');
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (!isBoolean(loginShell)) throw new Error('Invalid terminal login mode');
    const normalizedShell = isText(shell) ? normalizeTerminalShell(shell) : null;
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    const launchMode = normalizeCreateMode({ mode, command });
    const normalizedPurpose = normalizeTerminalPurpose({ purpose });
    const id = isText(sessionId) && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    const existing = sessions.get(id);
    const resolvedCwd = path.resolve(cwd);
    if (existing?.status === 'running') {
      if (path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (!isPurposeActionMatch(getSessionPurpose(existing), normalizedPurpose)) throw new Error('Terminal session is already running with a different purpose');
      if (normalizedPurpose.type === 'project-action') { applyAppearance(existing, { themeMode, terminalBackground, terminalForeground }); return existing; }
      if ((existing.mode ?? INTERACTIVE_TERMINAL_MODE) !== launchMode.mode) throw new Error('Terminal session is already running with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && existing.command !== launchMode.command) throw new Error('Terminal session is already running with a different command');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const runningActionSession = findRunningActionSession(sessions, resolvedCwd, normalizedPurpose, path);
    if (runningActionSession) {
      applyAppearance(runningActionSession, { themeMode, terminalBackground, terminalForeground });
      return runningActionSession;
    }
    const pending = pendingSessionCreates.get(id);
    if (pending) {
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (!isPurposeActionMatch(pending.purpose, normalizedPurpose)) throw new Error('Terminal session is already being created with a different purpose');
      if (normalizedPurpose.type === 'project-action') return pendingCreatePromise(pending);
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      if (pending.mode !== launchMode.mode) throw new Error('Terminal session is already being created with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && pending.command !== launchMode.command) throw new Error('Terminal session is already being created with a different command');
      const session = await pendingCreatePromise(pending);
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const pendingActionCreate = findPendingActionCreate(pendingSessionCreates, resolvedCwd, normalizedPurpose);
    if (pendingActionCreate) {
      const session = await pendingCreatePromise(pendingActionCreate);
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const superseded = normalizedPurpose.type === 'project-action'
      ? [...sessions.values()].filter((session) => session.id !== id && session.status === 'exited'
        && path.resolve(session.cwd) === resolvedCwd && isPurposeActionMatch(getSessionPurpose(session), normalizedPurpose))
      : [];
    if (!existing && sessions.size - superseded.length + pendingSessionCreates.size >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    const pendingEntry: PendingCreate = { cwd: resolvedCwd, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose, cancelled: false, promise: null };
    const creation = (async () => {
      const seed: TerminalSessionSeed = existing ?? { id, sequence: 0, history: newHistory(), pendingHistoryControlSequence: '', pendingThemeControlSequence: '', eventQueue: [], draining: false, createdAt: Date.now() };
      const { session, ptyProcess } = await startSession(seed, { cwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose });
      if (pendingEntry.cancelled) {
        session.retired = true;
        discardOutput(session);
        session.process = null;
        await terminateProcess(ptyProcess, true);
        throw new Error('Terminal session was closed during creation');
      }
      for (const previous of superseded) {
        if (sessions.get(previous.id) !== previous || previous.status !== 'exited') continue;
        sessions.delete(previous.id);
        previous.retired = true;
        discardOutput(previous);
        closeAttachments(previous.id, 'SUPERSEDED', 'Terminal replaced by a new action run');
      }
      sessions.set(id, session);
      announceSessionsChanged();
      return session;
    })();
    pendingEntry.promise = creation;
    pendingSessionCreates.set(id, pendingEntry);
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  wsServer.on('connection', (socket) => {
    const connection: Connection = { socket, attachments: new Map() };
    connections.add(connection);
    send(socket, { t: 'hello', v: 3 });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { return; } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!hasFrameFields(message) || message.v !== 3 || !isText(message.t)) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: 3 }); return; }
      if (message.t === 'hello') return;
      const id = isText(message.s) ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      const session = sessions.get(id);
      if (!session) { send(socket, { t: 'error', v: 3, s: id, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      if (message.t === 'attach') {
        const attachment: Attachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        flushOutput(session);
        const initial = snapshot(session);
        send(socket, initial, { gzip: message.z === 1 });
        for (const event of attachment.pending) if (event.q > initial.q) send(socket, event);
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (!isText(message.d) || !message.d || message.d.length > MAX_INPUT_CHARS) { send(socket, { t: 'error', v: 3, s: id, code: 'BAD_INPUT', message: 'Invalid terminal input', fatal: false }); return; }
        if (session.status !== 'running' || !session.process) { send(socket, { t: 'error', v: 3, s: id, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return; }
        try { session.process.write(message.d); session.lastActivity = Date.now(); } catch { send(socket, { t: 'error', v: 3, s: id, code: 'WRITE_FAILED', message: 'Failed to write to terminal', fatal: false }); }
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    const logUpgradeFailure = ({ error }: { error: unknown }) => {
      logger.warn?.(`[terminal] websocket upgrade failed: ${(hasErrorFields(error) && error.message) || error}`);
    };
    const accept = () => {
      const acceptingServer = wsServer;
      if (!acceptingServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
      try {
        acceptingServer.handleUpgrade(req, socket, head, (ws) => acceptingServer.emit('connection', ws, req));
      } catch (error) {
        logUpgradeFailure({ error });
        socket.destroy();
      }
    };
    const checkOrigin = () => {
      try {
        const result = isRequestOriginAllowed(req);
        if (!(result instanceof Promise)) {
          if (result) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        void result.then((allowed) => {
          if (allowed) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
      } catch (error) { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    };
    if (isOpaqueOriginRequest(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
    if (!uiAuthController?.enabled) {
      void isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed).then((allowed) => {
        if (allowed) accept();
        else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
      return;
    }
    try {
      const result = uiAuthController.ensureSessionToken(req, null);
      if (!(result instanceof Promise)) {
        if (result) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      void result.then((sessionToken) => {
        if (sessionToken) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
      }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
    } catch (error) { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
  };
  server.on('upgrade', upgradeHandler);

  app.get('/api/terminal/shells', async (_req, res) => {
    try {
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: (hasErrorFields(error) && error.message) || 'Failed to list terminal shells' });
    }
  });
  const listTerminals = ({ directory }: { directory?: string | undefined } = {}): TerminalListing[] => {
    const rawDirectory = directory?.trim();
    const cwdFilter = rawDirectory ? path.resolve(rawDirectory) : null;
    const list = [];
    for (const session of sessions.values()) {
      if (cwdFilter && path.resolve(session.cwd) !== cwdFilter) continue;
      list.push({
        sessionId: session.id,
        cwd: session.cwd,
        status: session.status,
        createdAt: Number.isInteger(session.createdAt) ? session.createdAt : null,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    return list;
  };

  const readTerminal = (sessionId: string, { maxBytes = DEFAULT_TERMINAL_READ_BYTES }: { maxBytes?: number } = {}): TerminalRead | null => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const requestedBytes = Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : DEFAULT_TERMINAL_READ_BYTES;
    const limit = Math.min(requestedBytes, MAX_TERMINAL_READ_BYTES);
    const text = terminalPlainText(historyText(session.history));
    const bytes = Buffer.from(text);
    let truncated = session.history.original === null;
    let start = 0;
    if (bytes.length > limit) {
      truncated = true;
      start = bytes.length - limit;
      while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    let readText = bytes.subarray(start).toString('utf8');
    if (start > 0 && bytes[start - 1] !== 0x0a) {
      const newline = readText.indexOf('\n');
      if (newline >= 0 && newline + 1 < readText.length) readText = readText.slice(newline + 1);
    }
    return {
      sessionId: session.id,
      cwd: session.cwd,
      status: session.status,
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
      createdAt: Number.isInteger(session.createdAt) ? session.createdAt : null,
      mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
      purpose: getSessionPurpose(session),
      text: readText,
      truncated,
      retainedBytes: session.history.bytes,
    };
  };

  app.get('/api/terminal/sessions', (req, res) => {
    const directory = isText(req.query?.cwd) ? req.query.cwd : undefined;
    res.json({ sessions: listTerminals({ directory }) });
  });
  app.post('/api/terminal/touch', (req, res) => {
    const body = hasRequestFields(req.body) ? req.body : undefined;
    const rawIds: unknown[] = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
    const now = Date.now();
    let touched = 0;
    for (const id of rawIds) {
      if (!isText(id)) continue;
      const session = sessions.get(id);
      if (!session) continue;
      session.lastActivity = now;
      touched += 1;
    }
    res.json({ touched });
  });
  app.post('/api/terminal/create', async (req, res) => {
    try {
      const session = await createSession(hasRequestFields(req.body) ? req.body : {});
      res.json({
        sessionId: session.id,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    catch (error) {
      const failure = hasErrorFields(error) ? error : undefined;
      res.status(failure?.message === 'Maximum terminal sessions reached' ? 429 : 400).json(errorBody(failure, 'Failed to create terminal session'));
    }
  });
  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const session = req.params.sessionId === undefined ? undefined : sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = hasRequestFields(req.body) ? req.body : {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { if (session.status === 'running') session.process?.resize(cols, rows); session.cols = cols; session.rows = rows; res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: (hasErrorFields(error) && error.message) || 'Failed to resize terminal' }); }
  });
  app.post('/api/terminal/:sessionId/appearance', (req, res) => {
    const session = req.params.sessionId === undefined ? undefined : sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, hasRequestFields(req.body) ? req.body : {});
    res.json({ success: true });
  });
  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const session = req.params.sessionId === undefined ? undefined : sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    if ((session.mode ?? INTERACTIVE_TERMINAL_MODE) === COMMAND_TERMINAL_MODE) return res.status(400).json({ error: 'Command-mode terminal sessions cannot be restarted' });
    const body = hasRequestFields(req.body) ? req.body : undefined;
    const requestedCwd = body?.cwd ?? session.cwd;
    const cols = body?.cols ?? session.cols;
    const rows = body?.rows ?? session.rows;
    const themeMode = body?.themeMode ?? session.themeMode;
    const terminalBackground = body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = body?.terminalForeground ?? session.terminalForeground;
    const shell = body?.shell ?? 'auto';
    const loginShell = body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      const cwd = await validateCwd({ cwd: requestedCwd });
      if (shutdownPromise || sessions.get(session.id) !== session) throw new Error('Terminal session was closed during restart');
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (!isBoolean(loginShell)) throw new Error('Invalid terminal login mode');
      const oldProcess = session.process;
      const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell });
      if (shutdownPromise || sessions.get(session.id) !== session) {
        await terminateProcess(spawned.process, true);
        throw new Error('Terminal session was closed during restart');
      }
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = cwd; session.cols = cols; session.rows = rows;
      session.shellExecutable = spawned.shellExecutable;
      flushOutput(session);
      session.history = newHistory(); session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
      wire(session, spawned.process); void terminateProcess(oldProcess); publish(session, { t: 'restarted', history: '' });
      announceSessionsChanged();
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) { res.status(400).json(errorBody(hasErrorFields(error) ? error : undefined, 'Failed to restart terminal')); }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  app.delete('/api/terminal/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (!session) {
      const pending = sessionId === undefined ? undefined : pendingSessionCreates.get(sessionId);
      if (!pending) return res.status(404).json({ error: 'Terminal session not found' });
      pending.cancelled = true;
      try { await pending.promise; }
      catch (error) {
        if (!hasErrorFields(error) || error.message !== 'Terminal session was closed during creation') throw error;
      }
      return res.json({ success: true });
    }
    sessions.delete(session.id);
    announceSessionsChanged();
    flushOutput(session);
    session.retired = true;
    closeAttachments(session.id, 'CLOSED', 'Terminal closed');
    await terminateProcess(session.process);
    res.json({ success: true });
  });
  app.post('/api/terminal/force-kill', (req, res) => {
    const { sessionId, cwd } = hasRequestFields(req.body) ? req.body : {}; let killedCount = 0;
    const killedSessionIds = [];
    for (const [id, session] of sessions) {
      if ((sessionId && id !== sessionId) || (!sessionId && cwd && session.cwd !== cwd)) continue;
      sessions.delete(id); flushOutput(session); session.retired = true; closeAttachments(id, 'KILLED', 'Terminal was killed'); void terminateProcess(session.process, true); killedSessionIds.push(id); killedCount += 1;
    }
    res.json({ success: true, killedCount, killedSessionIds });
    if (killedCount > 0) announceSessionsChanged();
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (!attached && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        sessions.delete(id); session.retired = true; discardOutput(session); closeAttachments(id, 'IDLE_TIMEOUT', 'Terminal expired after being idle'); void terminateProcess(session.process, true);
        announceSessionsChanged();
      }
    }
  }, 5 * 60 * 1000);

  const stop = async () => {
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    for (const session of sessions.values()) { session.retired = true; discardOutput(session); }
    for (const client of wsServer?.clients ?? []) client.terminate();
    for (const pending of pendingSessionCreates.values()) pending.cancelled = true;
    await Promise.allSettled([
      ...[...pendingSessionCreates.values()].map((pending) => pending.promise),
      ...pendingSessionRestarts.values(),
    ]);
    const terminals = [...sessions.values()]
      .filter((session): session is TerminalSession & { process: TerminalPty } => session.status === 'running' && Boolean(session.process))
      .map(session => ({ process: session.process, shellExecutable: session.shellExecutable }));
    const hadSessions = sessions.size > 0;
    sessions.clear();
    if (hadSessions) announceSessionsChanged();
    await shutdownProcesses(terminals);
    await Promise.allSettled([...pendingTerminations]);
    if (!wsServer) return;
    const closingServer = wsServer;
    if (!wsServer.clients) throw new TypeError('wsServer.clients is not iterable');
    for (const client of wsServer.clients) client.terminate();
    await Promise.race([
      new Promise((resolve) => closingServer.close(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    wsServer = null;
  };
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = stop();
    return shutdownPromise;
  };
  return { shutdown, listTerminals, readTerminal };
}
