import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_STORAGE_KEY_MAX, GUEST_STORAGE_VALUE_BYTES, type GuestProjectsSnapshot, type GuestWorktreesSnapshot, type GuestSessionsSnapshot, type GuestWorkspaceQuery, type GuestWorkspaceSnapshot, type GuestStorageOptions, type GuestStorageRequest, type GuestStorageResult } from './workspace.ts';
import type { GuestStatusControl, GuestStatusControlEvent } from './status-controls.ts';
import { isGuestStatusControls } from './status-controls.ts';
import type { GuestBlockCall, JsonValue } from './contract.ts';
import { isGuestPopoverRequest, type GuestPopoverClosedEvent, type GuestPopoverRequest } from './popover.ts';
import { guestNavigationCalls, type GuestNavigationClient } from './navigation.ts';
import {
  GUEST_FILE_EDITOR_CONTENT_MAX,
  GUEST_FILE_EDITOR_VERSION_MAX,
  type FileEditorChange,
  type FileEditorDocument,
  type FileEditorSnapshot,
  type FileSnapshotPurpose,
  type FileSnapshotResultPayload,
  fileEditorPayloadSize,
  sameFileEditorDocument,
} from './file-editor.ts';
import {
  GUEST_FILE_CONTENT_MAX,
  GUEST_CLIPBOARD_TEXT_MAX,
  GUEST_TOAST_MAX,
  GUEST_FILE_PATH_MAX,
  GUEST_GENERATE_OUTPUT_TOKENS_MAX,
  GUEST_GENERATE_PROMPT_MAX,
  GUEST_BLOCK_ANSWER_MAX,
  GUEST_GENERATE_SYSTEM_MAX,
  GUEST_GENERATE_TIMEOUT_MS,
  GUEST_REQUEST_TIMEOUT_MS,
  GUEST_RESOLVE_ERROR_MAX,
  isGuestFilePath,
  isGuestRequestPath,
  clampAttachRequest,
  clampBadgeCount,
  clampFrameHeight,
  clampPromptRequest,
  clampStartSessionRequest,
  readHostMessage,
  type AttachIssueRequest,
  type ActionResultPayload,
  type GuestActionItem,
  type ComposeRequest,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type StartSessionRequest,
  type GuestConnection,
  type GuestItem,
  type GuestMessage,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSettings,
  type HostReadyContext,
  type HostRequestErrorCode,
  type HostResultPayload,
  type ResolveRequest,
  type ResolveResultPayload,
  type SessionSnapshot,
  type StartSessionResult,
  type ToastRequest,
  type ServiceStatusResult,
  type FileListResult,
  type FileReadResult,
  type FileStatResult,
  type FileWriteResult,
  type GenerateRequest,
  type GenerateResult,
  type LateGenerateResult,
  isGenerateResult,
  isFileListResult,
  isFileReadResult,
  isFileStatResult,
  isJsonValue,
  isFileWriteResult,
  isServiceStatusResult,
  isGuestRequestResult,
  isPromptResult,
  isStartSessionResult,
} from './contract.ts';
import {
  GUEST_MICROPHONE_OPEN_TIMEOUT_MS,
  GUEST_MICROPHONE_SAMPLE_RATE_MAX,
  GUEST_MICROPHONE_SAMPLE_RATE_MIN,
  createSampleQueue,
  type GuestMicrophone,
  type GuestMicrophoneEndReason,
} from './microphone.ts';
import { GUEST_SHELL_ID_MAX, GUEST_SHELL_OUTPUT_TAIL_MAX, type GuestRunningShellsSnapshot, type GuestShellOutputResult, type GuestShellStopResult, type GuestShellsScope } from './shells.ts';

export type HostFrame = {
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
  parent: {
    postMessage: (message: GuestMessage, targetOrigin: string) => void;
  };
};

export type HostClientOptions = {
  target?: HostFrame;
  acceptSource?: (source: MessageEvent['source']) => boolean;
  requestTimeoutMs?: number;
};

export type HostClient = {
  listProjects: () => Promise<GuestProjectsSnapshot>;
  listWorktrees: (projectId: string) => Promise<GuestWorktreesSnapshot>;
  listSessions: (projectId: string) => Promise<GuestSessionsSnapshot>;
  onProjects: (listener: (snapshot: GuestProjectsSnapshot) => void) => Promise<() => void>;
  onWorktrees: (projectId: string, listener: (snapshot: GuestWorktreesSnapshot) => void) => Promise<() => void>;
  onSessions: (projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void) => Promise<() => void>;
  onRunningShells: (scope: GuestShellsScope, listener: (snapshot: GuestRunningShellsSnapshot) => void) => Promise<() => void>;
  readShellOutput: (shellId: string, options?: { cursor?: number; tailBytes?: number }) => Promise<GuestShellOutputResult>;
  stopShell: (shellId: string) => Promise<GuestShellStopResult>;
  openSession: (sessionId: string) => Promise<void>;
  storage: {
    get: (key: string, options?: GuestStorageOptions) => Promise<JsonValue | undefined>;
    set: (key: string, value: JsonValue, options?: GuestStorageOptions) => Promise<void>;
    delete: (key: string, options?: GuestStorageOptions) => Promise<void>;
    keys: (options?: GuestStorageOptions) => Promise<string[]>;
  };
  onReady: (listener: (context: HostReadyContext) => void) => () => void;
  onDirectory: (listener: (directory: string | null) => void) => () => void;
  onSession: (listener: (session: SessionSnapshot | null) => void) => () => void;
  onSessionLifecycle: (listener: (event: SessionLifecycleEvent) => void) => () => void;
  onConnection: (listener: (connection: GuestConnection) => void) => () => void;
  onSettings: (listener: (settings: GuestSettings) => void) => () => void;
  onItem: (listener: (item: GuestItem | null) => void) => () => void;
  onBlock: (listener: (block: GuestBlockCall) => void) => () => void;
  answerBlock: (text: string) => Promise<void>;
  onServiceEvent: (listener: (event: { topic: string; data: JsonValue }) => void) => () => void;
  onStatusControl: (listener: (event: GuestStatusControlEvent) => void) => () => void;
  onPopoverClosed: (listener: (event: GuestPopoverClosedEvent) => void) => () => void;
  setStatusControls: (controls: GuestStatusControl[]) => Promise<void>;
  openPopover: (request: GuestPopoverRequest) => Promise<void>;
  closePopover: (id: string, reason?: 'closed' | 'escape') => Promise<void>;
  setPopoverAnchorActive: (id: string, active: boolean) => Promise<void>;
  onResolve: (handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) => () => void;
  onAction: (handler: (item: GuestActionItem) => void | Promise<void>) => () => void;
  toast: (request: ToastRequest) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  openSurface: (surfaceId: string) => Promise<void>;
  writeClipboard: (text: string) => Promise<void>;
  compose: (request: ComposeRequest) => Promise<void>;
  attach: (request: AttachIssueRequest) => Promise<void>;
  startSession: (request: StartSessionRequest) => Promise<StartSessionResult>;
  prompt: (request: PromptRequest) => Promise<PromptResult>;
  sessionLink: (request: AttachIssueRequest) => Promise<void>;
  close: () => Promise<void>;
  oauthStart: () => Promise<void>;
  oauthDisconnect: () => Promise<void>;
  request: (request: GuestRequest) => Promise<GuestRequestResult>;
  serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
  serviceStatus: () => Promise<ServiceStatusResult>;
  readFile: (path: string) => Promise<FileReadResult>;
  writeFile: (path: string, content: string) => Promise<FileWriteResult>;
  listDir: (path: string) => Promise<FileListResult>;
  stat: (path: string) => Promise<FileStatResult>;
  generate: (request: GenerateRequest) => Promise<GenerateResult>;
  onLateGenerateResult: (listener: (result: LateGenerateResult) => void) => () => void;
  openMicrophone: () => Promise<GuestMicrophone>;
  setBadge: (count: number | null) => Promise<void>;
  setHeight: (height: number) => Promise<void>;
  onFileOpen: (listener: (file: FileEditorDocument) => void) => () => void;
  onFileSnapshot: (handler: (purpose: FileSnapshotPurpose) => Promise<FileEditorSnapshot> | FileEditorSnapshot) => () => void;
  onFileSaved: (listener: (version: string) => void) => () => void;
  reportFileChange: (change: FileEditorChange) => void;
  requestFileSave: () => void;
  reportFileUnsupported: () => void;
  dispose: () => void;
} & GuestNavigationClient;

// external: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof#instanceof_and_multiple_realms Event constructors belong to their realm; non-browser runtimes may have none.
const isKeyEvent = (event: Event): event is KeyboardEvent => 'key' in event && 'metaKey' in event && 'ctrlKey' in event;

const isSaveShortcut = (event: KeyboardEvent): boolean => (
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's'
);

export class HostRequestError extends Error {
  readonly code: HostRequestErrorCode;

  constructor(code: HostRequestErrorCode, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

type Pending = {
  resolve: (payload?: HostResultPayload) => void;
  reject: (error: HostRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
};

const rejectBadPath = (): Promise<never> => Promise.reject(
  new HostRequestError('BAD_PATH', 'Request path must start with "/" and stay on the declared origin.'),
);

const rejectBadFilePath = (): Promise<never> => Promise.reject(
  new HostRequestError('BAD_PATH', `File path must be 1 to ${GUEST_FILE_PATH_MAX} characters without NUL or backslash.`),
);

const deviceStorageScope = (options: GuestStorageOptions | undefined): 'device' | undefined => {
  if (options === undefined) return undefined;
  if (Object(options) !== options || Array.isArray(options)
    || (options.scope !== undefined && options.scope !== 'instance' && options.scope !== 'device')) {
    throw new HostRequestError('HOST_REJECTED', 'Storage scope must be "instance" or "device".');
  }
  return options.scope === 'device' ? 'device' : undefined;
};

const nextId = (n: { value: number }): string => {
  n.value += 1;
  return `oc-${n.value}`;
};

export const connectHost = (options: HostClientOptions = {}): HostClient => {
  const target = options.target ?? ('window' in globalThis ? window : null);
  if (!target) {
    throw new HostRequestError('HOST_UNAVAILABLE', 'No window. connectHost runs in a browser frame.');
  }
  const acceptSource = options.acceptSource ?? ((source: MessageEvent['source']) => source === target.parent);
  const requestTimeoutMs = options.requestTimeoutMs ?? GUEST_REQUEST_TIMEOUT_MS;

  const readyListeners = new Set<(context: HostReadyContext) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const sessionListeners = new Set<(session: SessionSnapshot | null) => void>();
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>();
  const connectionListeners = new Set<(connection: GuestConnection) => void>();
  const settingsListeners = new Set<(settings: GuestSettings) => void>();
  const itemListeners = new Set<(item: GuestItem | null) => void>();
  const blockListeners = new Set<(block: GuestBlockCall) => void>();
  const serviceEventListeners = new Set<(event: { topic: string; data: JsonValue }) => void>();
  const statusControlListeners = new Set<(event: GuestStatusControlEvent) => void>();
  const popoverClosedListeners = new Set<(event: GuestPopoverClosedEvent) => void>();
  const lateGenerateListeners = new Set<(result: LateGenerateResult) => void>();
  const unclaimedLateGenerate: LateGenerateResult[] = [];
  let resolveHandler: ((request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) | null = null;
  let actionHandler: ((item: GuestActionItem) => void | Promise<void>) | null = null;
  const fileOpenListeners = new Set<(file: FileEditorDocument) => void>();
  const fileSavedListeners = new Set<(version: string) => void>();
  let fileSnapshotHandler: ((purpose: FileSnapshotPurpose) => Promise<FileEditorSnapshot> | FileEditorSnapshot) | null = null;
  let lastFile: FileEditorDocument | null = null;
  let saveShortcutInstalled = false;
  const pending = new Map<string, Pending>();
  const workspaceListeners = new Map<string, (snapshot: GuestWorkspaceSnapshot) => void>();
  const shellsListeners = new Map<string, (snapshot: GuestRunningShellsSnapshot) => void>();
  let disposed = false;
  const ids = { value: 0 };
  let lastReady: HostReadyContext | null = null;
  let lastLifecycle: SessionLifecycleEvent | null = null;
  let popoverPointerActive = false;
  let popoverFocusActive = false;
  let popoverActivityReported: boolean | null = null;
  let microphone: {
    queue: ReturnType<typeof createSampleQueue>;
    endedListeners: Set<(reason: GuestMicrophoneEndReason) => void>;
    release: () => void;
  } | null = null;

  const lifecycleFromSession = (session: SessionSnapshot | null): SessionLifecycleEvent | null => {
    if (!session) return null;
    return {
      sessionId: session.id,
      phase: session.busy ? 'started' : 'completed',
    };
  };

  const post = (message: GuestMessage): void => {
    target.parent.postMessage(message, '*');
  };

  const listenForLateGenerate = (): void => {
    if (disposed || target.parent === target || lateGenerateListeners.size === 0
      || lastReady?.features?.lateGenerateResults !== true) return;
    post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'generate-late-listen' });
  };

  const emit = <T,>(listeners: Iterable<(value: T) => void>, value: T): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const onMessage = (event: Event): void => {
    if (!(event instanceof MessageEvent)) return;
    if (!acceptSource(event.source)) return;
    const message = readHostMessage(event.data);
    if (!message) return;
    if (message.type === 'workspace') {
      const listener = workspaceListeners.get(message.payload.subscriptionId);
      if (listener) emit([listener], message.payload.snapshot);
      return;
    }

    if (message.type === 'shells') {
      const listener = shellsListeners.get(message.payload.subscriptionId);
      if (listener) emit([listener], message.payload.snapshot);
      return;
    }

    if (message.type === 'microphone-audio') {
      microphone?.queue.push(message.payload.samples);
      return;
    }

    if (message.type === 'microphone-ended') {
      const open = microphone;
      if (!open) return;
      microphone = null;
      open.release();
      emit(open.endedListeners, message.payload.reason);
      return;
    }

    if (message.type === 'ready') {
      lastReady = message.payload;
      lastLifecycle = lifecycleFromSession(message.payload.session);
      emit(readyListeners, message.payload);
      emit(directoryListeners, message.payload.directory);
      emit(sessionListeners, message.payload.session);
      if (lastLifecycle) {
        emit(lifecycleListeners, lastLifecycle);
      }
      emit(connectionListeners, message.payload.connection);
      emit(settingsListeners, message.payload.settings);
      emit(itemListeners, message.payload.item);
      if (message.payload.block) emit(blockListeners, message.payload.block);
      listenForLateGenerate();
      return;
    }

    if (message.type === 'service-event') {
      emit(serviceEventListeners, message.payload);
      return;
    }

    if (message.type === 'generate-late') {
      if (lateGenerateListeners.size === 0) unclaimedLateGenerate.push(message.payload);
      else emit(lateGenerateListeners, message.payload);
      return;
    }

    if (message.type === 'directory') {
      if (lastReady) {
        lastReady = { ...lastReady, directory: message.payload.directory };
      }
      emit(directoryListeners, message.payload.directory);
      return;
    }

    if (message.type === 'session') {
      if (lastReady) {
        lastReady = { ...lastReady, session: message.payload.session };
      }
      if (!message.payload.session) {
        lastLifecycle = null;
      } else if (lastLifecycle?.sessionId !== message.payload.session.id) {
        lastLifecycle = lifecycleFromSession(message.payload.session);
      }
      emit(sessionListeners, message.payload.session);
      return;
    }

    if (message.type === 'session-lifecycle') {
      lastLifecycle = message.payload;
      emit(lifecycleListeners, message.payload);
      return;
    }

    if (message.type === 'connection') {
      if (lastReady) {
        lastReady = { ...lastReady, connection: message.payload.connection };
      }
      emit(connectionListeners, message.payload.connection);
      return;
    }

    if (message.type === 'settings') {
      if (lastReady) {
        lastReady = { ...lastReady, settings: message.payload.settings };
      }
      emit(settingsListeners, message.payload.settings);
      return;
    }

    if (message.type === 'item') {
      if (lastReady) {
        lastReady = { ...lastReady, item: message.payload.item };
      }
      emit(itemListeners, message.payload.item);
      return;
    }

    if (message.type === 'status-control-event') {
      emit(statusControlListeners, message.payload);
      return;
    }

    if (message.type === 'popover-closed') {
      emit(popoverClosedListeners, message.payload);
      return;
    }

    if (message.type === 'action') {
      const answer = (payload: ActionResultPayload): void => {
        if (!disposed) post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
          type: 'action-result', id: message.id, payload });
      };
      const handler = actionHandler;
      if (!handler) {
        answer({ ok: false, error: 'This extension does not handle background actions.' });
        return;
      }
      Promise.resolve().then(() => handler(message.payload)).then(
        () => answer({ ok: true }),
        (error) => {
          const text = (error instanceof Error ? error.message : String(error)).trim();
          answer({ ok: false, error: (text || 'Action failed.').slice(0, GUEST_RESOLVE_ERROR_MAX) });
        },
      );
      return;
    }

    if (message.type === 'file-open') {
      const next = message.payload;
      if (lastFile && sameFileEditorDocument(lastFile, next)) return;
      lastFile = next;
      emit(fileOpenListeners, message.payload);
      return;
    }

    if (message.type === 'file-saved') {
      emit(fileSavedListeners, message.payload.version);
      return;
    }

    if (message.type === 'file-snapshot') {
      const answer = (payload: FileSnapshotResultPayload): void => {
        if (!disposed) post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
          type: 'file-snapshot-result', id: message.id, payload });
      };
      const fail = (text: string): void => answer({ error: (text.trim() || 'Could not read the edited file.').slice(0, GUEST_RESOLVE_ERROR_MAX) });
      const handler = fileSnapshotHandler;
      if (!handler) {
        fail('This extension does not edit files.');
        return;
      }
      Promise.resolve().then(() => handler(message.payload.purpose)).then(
        (snapshot) => {
          if (fileEditorPayloadSize(snapshot) > GUEST_FILE_EDITOR_CONTENT_MAX) {
            fail(`The file is over ${GUEST_FILE_EDITOR_CONTENT_MAX} ${'bytes' in snapshot ? 'bytes' : 'characters'}.`);
            return;
          }
          if (snapshot.version.length > GUEST_FILE_EDITOR_VERSION_MAX) {
            fail(`The snapshot version is over ${GUEST_FILE_EDITOR_VERSION_MAX} characters.`);
            return;
          }
          answer({ snapshot: 'bytes' in snapshot
            ? { bytes: snapshot.bytes, version: snapshot.version }
            : { content: snapshot.content, version: snapshot.version } });
        },
        (error) => fail(error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    if (message.type === 'resolve') {
      const answer = (payload: ResolveResultPayload): void => {
        post({
          channel: OPENCHAMBER_SDK_CHANNEL,
          v: OPENCHAMBER_SDK_API_VERSION,
          type: 'resolve-result',
          id: message.id,
          payload,
        });
      };
      const handler = resolveHandler;
      if (!handler) {
        answer({ error: 'This extension does not resolve commands.' });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.payload))
        .then(
          (item) => answer({ item: item ? clampAttachRequest(item) : null }),
          (error) => {
            const text = (error instanceof Error ? error.message : String(error)).trim();
            answer({ error: (text || 'Command failed.').slice(0, GUEST_RESOLVE_ERROR_MAX) });
          },
        );
      return;
    }

    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.payload);
      return;
    }
    waiter.reject(new HostRequestError(message.code, message.error));
  };

  target.addEventListener('message', onMessage);
  post({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: OPENCHAMBER_SDK_API_VERSION,
    type: 'hello',
  });

  type GuestCallMessage = Extract<GuestMessage, { id: string }>;

  const send = (
    message: GuestCallMessage,
    timeoutMs: number = requestTimeoutMs,
  ): Promise<HostResultPayload | undefined> => {
    if (disposed || target.parent === target) {
      return Promise.reject(new HostRequestError('HOST_UNAVAILABLE', 'No host frame. This page is not in an iframe.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new HostRequestError('HOST_TIMEOUT', 'Host did not answer in time.'));
      }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      post(message);
    });
  };

  const request = (message: GuestCallMessage): Promise<void> => (
    send(message).then(() => undefined)
  );

  const envelope: Pick<GuestMessage, 'channel' | 'v'> = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION };
  const notify = (message: Extract<GuestMessage, { type: 'file-change' | 'file-save' | 'file-unsupported' }>): void => {
    if (!disposed && target.parent !== target) post(message);
  };
  const requestFileSave = (): void => notify({ ...envelope, type: 'file-save' });

  const postMicrophoneClose = (): void => {
    if (!disposed && target.parent !== target) post({ ...envelope, type: 'microphone-close', id: nextId(ids) });
  };

  const openMicrophone = async (): Promise<GuestMicrophone> => {
    if (microphone) throw new HostRequestError('HOST_REJECTED', 'The microphone is already open in this frame.');
    if (lastReady?.features?.microphone !== true) {
      throw new HostRequestError('UNSUPPORTED', 'This OpenChamber cannot share the microphone with extensions.');
    }
    const AudioContextCtor = globalThis.AudioContext;
    if (typeof AudioContextCtor !== 'function') throw new HostRequestError('UNSUPPORTED', 'This frame has no Web Audio.');
    const context = new AudioContextCtor();
    if (context.sampleRate < GUEST_MICROPHONE_SAMPLE_RATE_MIN || context.sampleRate > GUEST_MICROPHONE_SAMPLE_RATE_MAX) {
      void context.close().catch(() => undefined);
      throw new HostRequestError('UNSUPPORTED', `Audio at ${context.sampleRate} Hz is not supported.`);
    }
    const resumed = context.state === 'suspended' ? context.resume().catch(() => undefined) : undefined;
    const queue = createSampleQueue(Math.round(context.sampleRate / 4));
    const processor = context.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => queue.pull(event.outputBuffer.getChannelData(0));
    const destination = context.createMediaStreamDestination();
    processor.connect(destination);
    const endedListeners = new Set<(reason: GuestMicrophoneEndReason) => void>();
    const open = {
      queue,
      endedListeners,
      release: () => {
        processor.onaudioprocess = null;
        processor.disconnect();
        queue.clear();
        for (const track of destination.stream.getTracks()) track.stop();
        void context.close().catch(() => undefined);
      },
    };
    microphone = open;
    try {
      const result = await send(
        { ...envelope, type: 'microphone-open', id: nextId(ids), payload: { sampleRate: context.sampleRate } },
        GUEST_MICROPHONE_OPEN_TIMEOUT_MS,
      );
      if (!result || !('opened' in result) || result.opened !== true) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not open the microphone.');
      }
      await resumed;
      if (microphone !== open) throw new HostRequestError('DISCONNECTED', 'The microphone closed while it was opening.');
    } catch (error) {
      if (microphone === open) microphone = null;
      open.release();
      postMicrophoneClose();
      throw error;
    }
    return {
      stream: destination.stream,
      close: () => {
        if (microphone !== open) return;
        microphone = null;
        open.release();
        postMicrophoneClose();
      },
      onEnded: (listener) => {
        endedListeners.add(listener);
        return () => { endedListeners.delete(listener); };
      },
    };
  };
  const onSaveShortcut = (event: Event): void => {
    if (!isKeyEvent(event) || !isSaveShortcut(event)) return;
    event.preventDefault();
    requestFileSave();
  };
  const onPopoverEscape = (event: Event): void => {
    if (!isKeyEvent(event) || event.key !== 'Escape' || lastReady?.surface !== 'popover' || !lastReady.popover) return;
    event.preventDefault();
    void closePopover(lastReady.popover.id, 'escape').catch(() => undefined);
  };
  const reportPopoverActivity = (): void => {
    const popover = lastReady?.surface === 'popover' ? lastReady.popover : undefined;
    if (!popover) return;
    const active = popoverPointerActive || popoverFocusActive;
    if (popoverActivityReported === active) return;
    popoverActivityReported = active;
    void setPopoverAnchorActive(popover.id, active).catch(() => undefined);
  };
  const onPopoverPointerOver = (): void => {
    if (lastReady?.surface !== 'popover' || popoverPointerActive) return;
    popoverPointerActive = true;
    reportPopoverActivity();
  };
  const onPopoverPointerOut = (event: PointerEvent): void => {
    if (lastReady?.surface !== 'popover' || event.relatedTarget !== null || !popoverPointerActive) return;
    popoverPointerActive = false;
    reportPopoverActivity();
  };
  const onPopoverFocus = (): void => {
    if (lastReady?.surface !== 'popover' || popoverFocusActive) return;
    popoverFocusActive = true;
    reportPopoverActivity();
  };
  const onPopoverBlur = (): void => {
    if (lastReady?.surface !== 'popover' || !popoverFocusActive) return;
    popoverFocusActive = false;
    reportPopoverActivity();
  };
  const requireIdentity = (value: string, maximum = 1024): void => {
    if (!value.trim() || value.length > maximum) throw new HostRequestError('HOST_REJECTED', `Identity must contain 1 to ${maximum} characters.`);
  };
  const readWorkspace = async (query: GuestWorkspaceQuery): Promise<GuestWorkspaceSnapshot> => {
    if (query.kind !== 'projects') requireIdentity(query.projectId);
    const result = await send({ ...envelope, type: 'workspace-read', id: nextId(ids), payload: query });
    if (!result || !('kind' in result) || !('state' in result) || result.kind !== query.kind) {
      throw new HostRequestError('HOST_REJECTED', 'Host did not return workspace data.');
    }
    return result;
  };
  const subscribeWorkspace = async (query: GuestWorkspaceQuery, listener: (snapshot: GuestWorkspaceSnapshot) => void): Promise<() => void> => {
    if (query.kind !== 'projects') requireIdentity(query.projectId);
    const subscriptionId = nextId(ids);
    workspaceListeners.set(subscriptionId, listener);
    try {
      await request({ ...envelope, type: 'workspace-subscribe', id: nextId(ids), payload: { subscriptionId, query } });
    } catch (error) {
      workspaceListeners.delete(subscriptionId);
      if (!disposed) post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      throw error;
    }
    return () => {
      if (!workspaceListeners.delete(subscriptionId) || disposed) return;
      post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
    };
  };
  const subscribeShells = async (scope: GuestShellsScope, listener: (snapshot: GuestRunningShellsSnapshot) => void): Promise<() => void> => {
    if (scope.kind === 'session') requireIdentity(scope.sessionId);
    if (scope.kind === 'project') requireIdentity(scope.projectId);
    const subscriptionId = nextId(ids);
    shellsListeners.set(subscriptionId, listener);
    try {
      await request({ ...envelope, type: 'shells-subscribe', id: nextId(ids), payload: { subscriptionId, scope } });
    } catch (error) {
      shellsListeners.delete(subscriptionId);
      if (!disposed) post({ ...envelope, type: 'shells-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      throw error;
    }
    return () => {
      if (!shellsListeners.delete(subscriptionId) || disposed) return;
      post({ ...envelope, type: 'shells-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
    };
  };
  const storage = async (payload: GuestStorageRequest): Promise<GuestStorageResult> => {
    if ('key' in payload && (payload.key.length === 0 || payload.key.length > GUEST_STORAGE_KEY_MAX)) {
      throw new HostRequestError('HOST_REJECTED', 'Storage key must contain 1 to 128 characters.');
    }
    if (payload.op === 'set' && !isJsonValue(payload.value)) {
      throw new HostRequestError('HOST_REJECTED', 'Storage values must be JSON.');
    }
    if (payload.op === 'set' && new TextEncoder().encode(JSON.stringify(payload.value)).length > GUEST_STORAGE_VALUE_BYTES) {
      throw new HostRequestError('HOST_REJECTED', 'Storage value exceeds 64 KiB.');
    }
    if (payload.scope === 'device' && lastReady?.features?.deviceStorage !== true) {
      throw new HostRequestError('UNSUPPORTED', 'This host does not support device storage.');
    }
    const result = await send({ ...envelope, type: 'storage', id: nextId(ids), payload });
    if (!result || !('storage' in result) || result.op !== payload.op) throw new HostRequestError('HOST_REJECTED', 'Host did not return storage data.');
    return result;
  };
  const closePopover = (id: string, reason?: 'closed' | 'escape'): Promise<void> => (
    lastReady?.features?.popovers !== true && !(lastReady?.surface === 'popover' && lastReady.popover?.id === id)
      ? Promise.reject(new HostRequestError('UNSUPPORTED', 'This host does not support popovers.'))
      : request({ ...envelope, type: 'popover-close', id: nextId(ids), payload: reason ? { id, reason } : { id } })
  );
  const setPopoverAnchorActive = (id: string, active: boolean): Promise<void> => (
    lastReady?.features?.popovers !== true && !(lastReady?.surface === 'popover' && lastReady.popover?.id === id)
      ? Promise.reject(new HostRequestError('UNSUPPORTED', 'This host does not support popovers.'))
      : request({ ...envelope, type: 'popover-anchor', id: nextId(ids), payload: { id, active } })
  );
  target.addEventListener('keydown', onPopoverEscape, true);
  target.addEventListener('pointerover', onPopoverPointerOver);
  target.addEventListener('pointermove', onPopoverPointerOver);
  target.addEventListener('pointerout', onPopoverPointerOut);
  target.addEventListener('focus', onPopoverFocus);
  target.addEventListener('blur', onPopoverBlur);

  return {
    onAction: (handler) => {
      actionHandler = handler;
      return () => { if (actionHandler === handler) actionHandler = null; };
    },
    listProjects: async () => {
      const result = await readWorkspace({ kind: 'projects' });
      if (result.kind !== 'projects') throw new HostRequestError('HOST_REJECTED', 'Expected projects.');
      return result;
    },
    listWorktrees: async (projectId) => {
      const result = await readWorkspace({ kind: 'worktrees', projectId });
      if (result.kind !== 'worktrees') throw new HostRequestError('HOST_REJECTED', 'Expected worktrees.');
      return result;
    },
    listSessions: async (projectId) => {
      const result = await readWorkspace({ kind: 'sessions', projectId });
      if (result.kind !== 'sessions') throw new HostRequestError('HOST_REJECTED', 'Expected sessions.');
      return result;
    },
    onProjects: (listener) => subscribeWorkspace({ kind: 'projects' }, (snapshot) => { if (snapshot.kind === 'projects') listener(snapshot); }),
    onWorktrees: (projectId, listener) => subscribeWorkspace({ kind: 'worktrees', projectId }, (snapshot) => { if (snapshot.kind === 'worktrees') listener(snapshot); }),
    onSessions: (projectId, listener) => subscribeWorkspace({ kind: 'sessions', projectId }, (snapshot) => { if (snapshot.kind === 'sessions') listener(snapshot); }),
    onRunningShells: (scope, listener) => subscribeShells(scope, listener),
    readShellOutput: async (shellId, options) => {
      requireIdentity(shellId, GUEST_SHELL_ID_MAX);
      const cursor = options?.cursor;
      if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
        throw new HostRequestError('HOST_REJECTED', 'Shell output cursor must be a non-negative integer.');
      }
      const tailBytes = options?.tailBytes;
      if (tailBytes !== undefined && (!Number.isInteger(tailBytes) || tailBytes < 1 || tailBytes > GUEST_SHELL_OUTPUT_TAIL_MAX)) {
        throw new HostRequestError('HOST_REJECTED', `Shell output tailBytes must be an integer between 1 and ${GUEST_SHELL_OUTPUT_TAIL_MAX}.`);
      }
      const result = await send({ ...envelope, type: 'shell-output', id: nextId(ids), payload: { shellId, cursor, tailBytes } });
      const output = result as GuestShellOutputResult | undefined;
      if (!output || typeof output.output !== 'string' || !Number.isFinite(output.cursor)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return shell output.');
      }
      return output;
    },
    stopShell: async (shellId) => {
      requireIdentity(shellId, GUEST_SHELL_ID_MAX);
      const result = (await send({ ...envelope, type: 'shell-stop', id: nextId(ids), payload: { shellId } })) as GuestShellStopResult | undefined;
      if (result?.stopped !== true) throw new HostRequestError('HOST_REJECTED', 'Host did not stop the shell.');
      return { stopped: true as const };
    },
    openSession: async (sessionId) => {
      requireIdentity(sessionId);
      await request({ ...envelope, type: 'open-session', id: nextId(ids), payload: { sessionId } });
    },
    storage: {
      get: async (key, options) => {
        const scope = deviceStorageScope(options);
        const payload: GuestStorageRequest = { op: 'get', key };
        if (scope) payload.scope = scope;
        const result = await storage(payload);
        return result.op === 'get' && result.found ? result.value : undefined;
      },
      set: async (key, value, options) => {
        const scope = deviceStorageScope(options);
        const payload: GuestStorageRequest = { op: 'set', key, value };
        if (scope) payload.scope = scope;
        await storage(payload);
      },
      delete: async (key, options) => {
        const scope = deviceStorageScope(options);
        const payload: GuestStorageRequest = { op: 'delete', key };
        if (scope) payload.scope = scope;
        await storage(payload);
      },
      keys: async (options) => {
        const scope = deviceStorageScope(options);
        const payload: GuestStorageRequest = { op: 'keys' };
        if (scope) payload.scope = scope;
        const result = await storage(payload);
        if (result.op !== 'keys') throw new HostRequestError('HOST_REJECTED', 'Expected storage keys.');
        return result.keys;
      },
    },
    onReady: (listener) => {
      readyListeners.add(listener);
      if (lastReady) listener(lastReady);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onDirectory: (listener) => {
      directoryListeners.add(listener);
      if (lastReady) listener(lastReady.directory);
      return () => {
        directoryListeners.delete(listener);
      };
    },
    onSession: (listener) => {
      sessionListeners.add(listener);
      if (lastReady) listener(lastReady.session);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    onSessionLifecycle: (listener) => {
      lifecycleListeners.add(listener);
      if (lastLifecycle) listener(lastLifecycle);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
    onConnection: (listener) => {
      connectionListeners.add(listener);
      if (lastReady) listener(lastReady.connection);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    onSettings: (listener) => {
      settingsListeners.add(listener);
      if (lastReady) listener(lastReady.settings);
      return () => {
        settingsListeners.delete(listener);
      };
    },
    onItem: (listener) => {
      itemListeners.add(listener);
      if (lastReady) listener(lastReady.item);
      return () => {
        itemListeners.delete(listener);
      };
    },
    onBlock: (listener) => {
      blockListeners.add(listener);
      if (lastReady?.block) listener(lastReady.block);
      return () => {
        blockListeners.delete(listener);
      };
    },
    onServiceEvent: (listener) => {
      serviceEventListeners.add(listener);
      return () => {
        serviceEventListeners.delete(listener);
      };
    },
    onStatusControl: (listener) => {
      statusControlListeners.add(listener);
      return () => {
        statusControlListeners.delete(listener);
      };
    },
    onPopoverClosed: (listener) => {
      popoverClosedListeners.add(listener);
      return () => { popoverClosedListeners.delete(listener); };
    },
    setStatusControls: (controls) => {
      if (lastReady?.features?.statusControls !== true) {
        return Promise.reject(new HostRequestError('UNSUPPORTED', 'This host does not support status controls.'));
      }
      if (!isGuestStatusControls(controls)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', 'Status controls must have unique bounded ids and valid selected options.'));
      }
      return request({ ...envelope, type: 'status-controls', id: nextId(ids), payload: { controls } });
    },
    openPopover: (payload) => {
      if (lastReady?.features?.popovers !== true) {
        return Promise.reject(new HostRequestError('UNSUPPORTED', 'This host does not support popovers.'));
      }
      if (!isGuestPopoverRequest(payload)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', 'Popover requests need bounded geometry and JSON data.'));
      }
      return request({ ...envelope, type: 'popover-open', id: nextId(ids), payload });
    },
    closePopover,
    setPopoverAnchorActive,
    onResolve: (handler) => {
      resolveHandler = handler;
      return () => {
        if (resolveHandler === handler) resolveHandler = null;
      };
    },
    toast: (payload) => {
      const message = payload.message.trim();
      if (!message || message.length > GUEST_TOAST_MAX) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast message must contain 1 to ${GUEST_TOAST_MAX} characters.`));
      }
      if (payload.copy && payload.copy !== true && (!payload.copy.text.length || payload.copy.text.length > GUEST_CLIPBOARD_TEXT_MAX)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast copy text must contain 1 to ${GUEST_CLIPBOARD_TEXT_MAX} characters.`));
      }
      return request({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'toast',
        id: nextId(ids),
        payload: { ...payload, message },
      });
    },
    openUrl: (url) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-url',
      id: nextId(ids),
      payload: { url },
    }),
    ...guestNavigationCalls(request, () => nextId(ids), (message) => Promise.reject(new HostRequestError('HOST_REJECTED', message))),
    answerBlock: (text) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'block-answer',
      id: nextId(ids),
      payload: { text: text.trim().slice(0, GUEST_BLOCK_ANSWER_MAX) },
    }),
    openSurface: (surfaceId) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-surface',
      id: nextId(ids),
      payload: { surfaceId },
    }),
    writeClipboard: (text) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'clipboard-write',
      id: nextId(ids),
      payload: { text },
    }),
    compose: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'compose',
      id: nextId(ids),
      payload,
    }),
    attach: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'attach',
      id: nextId(ids),
      payload: clampAttachRequest(payload),
    }),
    startSession: async (payload) => {
      if (payload.projectId !== undefined) requireIdentity(payload.projectId);
      const worktree = payload.worktree;
      if (worktree && worktree !== true) {
        if (worktree.kind === 'existing') requireIdentity(worktree.directory);
        else {
          if (worktree.name !== undefined) requireIdentity(worktree.name, 200);
          if (worktree.baseBranch !== undefined) requireIdentity(worktree.baseBranch, 200);
        }
      }
      const result = await send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'start-session',
      id: nextId(ids),
      payload: clampStartSessionRequest(payload),
    }, options.requestTimeoutMs ?? 180_000);
      if (!isStartSessionResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return a session.');
      }
      return result;
    },
    prompt: (payload) => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'prompt',
      id: nextId(ids),
      payload: clampPromptRequest(payload),
    }).then((result) => {
      if (!isPromptResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return a prompt result.');
      }
      return result;
    }),
    sessionLink: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'session-link',
      id: nextId(ids),
      payload: clampAttachRequest(payload),
    }),
    close: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'close',
      id: nextId(ids),
    }),
    oauthStart: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'oauth-start',
      id: nextId(ids),
    }),
    oauthDisconnect: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'oauth-disconnect',
      id: nextId(ids),
    }),
    request: (payload) => (isGuestRequestPath(payload.path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'request',
      id: nextId(ids),
      payload,
    }) : rejectBadPath()).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host request result was empty.');
      }
      return result;
    }),
    serviceRequest: (payload) => (isGuestRequestPath(payload.path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'service-request',
      id: nextId(ids),
      payload,
    }) : rejectBadPath()).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host service request result was empty.');
      }
      return result;
    }),
    serviceStatus: () => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'service-status',
      id: nextId(ids),
    }).then((result) => {
      if (!isServiceStatusResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return service status.');
      }
      return result;
    }),
    readFile: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-read',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileReadResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return file content.');
      }
      return result;
    }),
    writeFile: (path, content) => {
      if (!isGuestFilePath(path)) {
        return rejectBadFilePath();
      }
      if (content.length > GUEST_FILE_CONTENT_MAX) {
        return Promise.reject(new HostRequestError('FILE_TOO_LARGE', `Content is over ${GUEST_FILE_CONTENT_MAX} characters.`));
      }
      return send({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'file-write',
        id: nextId(ids),
        payload: { path, content },
      }).then((result) => {
        if (!isFileWriteResult(result)) {
          throw new HostRequestError('HOST_REJECTED', 'Host did not confirm the write.');
        }
        return result;
      });
    },
    listDir: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-list',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileListResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return directory entries.');
      }
      return result;
    }),
    stat: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-stat',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileStatResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return file status.');
      }
      return result;
    }),
    generate: (input) => {
      const prompt = input.prompt.trim();
      const system = input.system?.trim();
      if (prompt.length === 0 || prompt.length > GUEST_GENERATE_PROMPT_MAX) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Prompt must be 1 to ${GUEST_GENERATE_PROMPT_MAX} characters.`));
      }
      if (system !== undefined && (system.length === 0 || system.length > GUEST_GENERATE_SYSTEM_MAX)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `System prompt must be 1 to ${GUEST_GENERATE_SYSTEM_MAX} characters.`));
      }
      const maxOutputTokens = input.maxOutputTokens === undefined
        ? undefined
        : Math.min(GUEST_GENERATE_OUTPUT_TOKENS_MAX, Math.max(1, Math.floor(input.maxOutputTokens)));
      if (maxOutputTokens !== undefined && !Number.isFinite(maxOutputTokens)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', 'maxOutputTokens must be a number.'));
      }
      const payload: GenerateRequest = { prompt };
      if (system !== undefined) payload.system = system;
      if (maxOutputTokens !== undefined) payload.maxOutputTokens = maxOutputTokens;
      return send({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'generate',
        id: nextId(ids),
        payload,
      }, options.requestTimeoutMs ?? GUEST_GENERATE_TIMEOUT_MS).then((result) => {
        if (!isGenerateResult(result)) {
          throw new HostRequestError('HOST_REJECTED', 'Host did not return generated text.');
        }
        return result;
      });
    },
    onLateGenerateResult: (listener) => {
      lateGenerateListeners.add(listener);
      for (const result of unclaimedLateGenerate.splice(0)) emit([listener], result);
      listenForLateGenerate();
      return () => { lateGenerateListeners.delete(listener); };
    },
    openMicrophone,
    setBadge: (count) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'badge',
      id: nextId(ids),
      payload: { count: clampBadgeCount(count) },
    }),
    setHeight: (height) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'resize',
      id: nextId(ids),
      payload: { height: clampFrameHeight(height) },
    }),
    onFileOpen: (listener) => {
      fileOpenListeners.add(listener);
      if (!saveShortcutInstalled) {
        saveShortcutInstalled = true;
        target.addEventListener('keydown', onSaveShortcut, true);
      }
      if (lastFile) listener(lastFile);
      return () => {
        fileOpenListeners.delete(listener);
      };
    },
    onFileSnapshot: (handler) => {
      fileSnapshotHandler = handler;
      return () => {
        if (fileSnapshotHandler === handler) fileSnapshotHandler = null;
      };
    },
    onFileSaved: (listener) => {
      fileSavedListeners.add(listener);
      return () => {
        fileSavedListeners.delete(listener);
      };
    },
    reportFileChange: (change) => notify({ ...envelope, type: 'file-change', payload: { dirty: change.dirty, edited: change.edited } }),
    requestFileSave,
    reportFileUnsupported: () => notify({ ...envelope, type: 'file-unsupported' }),
    dispose: () => {
      for (const subscriptionId of workspaceListeners.keys()) {
        post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      }
      workspaceListeners.clear();
      for (const subscriptionId of shellsListeners.keys()) {
        post({ ...envelope, type: 'shells-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      }
      shellsListeners.clear();
      if (microphone) {
        postMicrophoneClose();
        microphone.release();
        microphone = null;
      }
      disposed = true;
      resolveHandler = null;
      actionHandler = null;
      fileSnapshotHandler = null;
      fileOpenListeners.clear();
      fileSavedListeners.clear();
      if (saveShortcutInstalled) target.removeEventListener('keydown', onSaveShortcut, true);
      target.removeEventListener('message', onMessage);
      target.removeEventListener('keydown', onPopoverEscape, true);
      target.removeEventListener('pointerover', onPopoverPointerOver);
      target.removeEventListener('pointermove', onPopoverPointerOver);
      target.removeEventListener('pointerout', onPopoverPointerOut);
      target.removeEventListener('focus', onPopoverFocus);
      target.removeEventListener('blur', onPopoverBlur);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new HostRequestError('HOST_UNAVAILABLE', 'Host client was disposed.'));
      }
      pending.clear();
      readyListeners.clear();
      directoryListeners.clear();
      sessionListeners.clear();
      lifecycleListeners.clear();
      connectionListeners.clear();
      settingsListeners.clear();
      itemListeners.clear();
      blockListeners.clear();
      serviceEventListeners.clear();
      statusControlListeners.clear();
      popoverClosedListeners.clear();
      lateGenerateListeners.clear();
      unclaimedLateGenerate.length = 0;
    },
  };
};
