
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import type { FileEditorChange, FileEditorDocument, FileSnapshotRequest, FileSnapshotResultPayload } from './file-editor.ts';
import type { GuestMicrophoneEndReason, MicrophoneOpenRequest, MicrophoneOpenResult } from './microphone.ts';
import type { GuestRunningShellsSnapshot, GuestShellOutputRequest, GuestShellOutputResult, GuestShellStopResult, GuestShellsSubscription } from './shells.ts';
import type { GuestSessionWorktree, GuestStorageRequest, GuestStorageResult, GuestWorkspaceQuery, GuestWorkspaceSnapshot, GuestWorkspaceSubscription, GuestWorkspaceUpdate, GuestWorktree } from './workspace.ts';
import type { GuestStatusControl, GuestStatusControlEvent } from './status-controls.ts';
import type { GuestPopoverClosedEvent, GuestPopoverContext, GuestPopoverRequest } from './popover.ts';

export type HostThemeMode = 'light' | 'dark';

export type HostThemeTokens = {
  background: string;
  elevated: string;
  foreground: string;
  muted: string;
  subtle: string;
  border: string;
  hover: string;
  selection: string;
  focus: string;
  primary: string;
  mutedSurface: string;
  elevatedForeground: string;
  active: string;
  selectionForeground: string;
  primaryForeground: string;
  primaryText: string;
  successText: string;
  warningText: string;
  errorText: string;
  infoText: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  font: string;
  fontSize?: string;
  mono: string;
  radius: string;
  syntaxKeyword?: string;
  syntaxString?: string;
  syntaxNumber?: string;
  syntaxFunction?: string;
  syntaxType?: string;
  syntaxComment?: string;
  syntaxVariable?: string;
  syntaxOperator?: string;
};

export type HostTheme = {
  mode: HostThemeMode;
  tokens: HostThemeTokens;
};

export const START_SESSION_SENT = ['sent', 'no-model', 'skipped', 'failed'] as const;

export type StartSessionSent = (typeof START_SESSION_SENT)[number];

export type SessionSnapshot = {
  id: string;
  title: string;
  busy: boolean;
  model?: string;
  agent?: string;
};

export type GuestHostSurface = 'panel' | 'dialog' | 'page' | 'background' | 'status' | 'file' | 'popover' | 'block';

export type GuestBlockCall = {
  name: string;
  args: Record<string, string>;
  answered: string | null;
};

export const GUEST_BLOCK_ANSWER_MAX = 2_000;

export type GuestConnection = {
  connected: boolean;
  account: string;
};

export type GuestSettings = Record<string, string>;

export type GuestRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type GuestRequest = {
  method: GuestRequestMethod;
  path: string;
  query?: Record<string, string>;
  body?: string;
};

export type GuestRequestResult = {
  status: number;
  body: string;
};

export type StartSessionResult = {
  sessionId: string;
  sent: StartSessionSent;
  directory?: string;
  worktree?: GuestWorktree;
  linked?: boolean;
} | {
  sessionId: null;
  sent: 'skipped';
  directory: string;
  worktree: GuestWorktree;
  failure: 'bootstrap-failed' | 'session-create-failed';
};

export type PromptRequest = {
  text: string;
  send?: boolean;
};

export type PromptResult = {
  sent: StartSessionSent;
};

export const SESSION_LIFECYCLE_PHASES = ['started', 'completed', 'failure'] as const;

export type SessionLifecyclePhase = (typeof SESSION_LIFECYCLE_PHASES)[number];

export type SessionLifecycleEvent = {
  sessionId: string;
  phase: SessionLifecyclePhase;
};

export const GUEST_FILE_ENTRY_KINDS = ['file', 'directory', 'other'] as const;

export type GuestFileEntryKind = (typeof GUEST_FILE_ENTRY_KINDS)[number];

export const GUEST_FILE_STAT_KINDS = ['file', 'directory', 'other', 'missing'] as const;

export type GuestFileStatKind = (typeof GUEST_FILE_STAT_KINDS)[number];

export type GuestFileScope = 'project' | 'filesystem';

export type FileReadRequest = { path: string };
export type FileWriteRequest = { path: string; content: string };
export type FileListRequest = { path: string };
export type FileStatRequest = { path: string };

export type FileReadResult = { content: string };
export type FileWriteResult = { written: true };
export type FileListEntry = { name: string; kind: GuestFileEntryKind };
export type FileListResult = { entries: FileListEntry[] };
export type FileStatResult = { kind: GuestFileStatKind; size: number; mtime: number };

export type GenerateRequest = {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
};

export type GenerateResult = { text: string };

export type LateGenerateResult = { request: GenerateRequest } & (
  | { ok: true; result: GenerateResult }
  | { ok: false; code: HostRequestErrorCode; error: string }
);

export type HostResultPayload =
  | GuestStorageResult
  | GuestWorkspaceSnapshot
  | GuestShellOutputResult
  | GuestShellStopResult
  | GuestRequestResult
  | StartSessionResult
  | PromptResult
  | ServiceStatusResult
  | FileReadResult
  | FileWriteResult
  | FileListResult
  | FileStatResult
  | GenerateResult
  | MicrophoneOpenResult;

export const isStartSessionResult = (
  value: HostResultPayload | undefined,
): value is StartSessionResult => Boolean(value && 'sessionId' in value);

export const isPromptResult = (
  value: HostResultPayload | undefined,
): value is PromptResult => Boolean(value && 'sent' in value && !('sessionId' in value));

export const EMPTY_GUEST_CONNECTION: GuestConnection = {
  connected: false,
  account: '',
};

export type HostReadyContext = {
  theme: HostTheme;
  locale: string;
  directory: string | null;
  session: SessionSnapshot | null;
  surface: GuestHostSurface;
  connection: GuestConnection;
  settings: GuestSettings;
  item: GuestItem | null;
  block?: GuestBlockCall;
  popover?: GuestPopoverContext;
  features?: {
    deviceStorage?: true;
    statusControls?: true;
    popovers?: true;
    lateGenerateResults?: true;
    microphone?: true;
  };
  device?: HostDevice;
};

export const DEVICE_FORM_FACTORS = ['phone', 'tablet', 'desktop'] as const;
export const DEVICE_POINTERS = ['coarse', 'fine'] as const;

export type HostDevice = {
  formFactor: (typeof DEVICE_FORM_FACTORS)[number];
  pointer: (typeof DEVICE_POINTERS)[number];
  insets: { top: number; right: number; bottom: number; left: number };
  keyboard: number;
};

export type GuestItemRole = 'user' | 'assistant';

export type GuestMessageItem = {
  kind: 'message';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string | null;
  messageId: string;
  role: GuestItemRole;
  text: string;
};

export type GuestSessionItemMessage = {
  id: string;
  role: GuestItemRole;
  text: string;
  createdAt: number;
};

export type GuestSessionItem = {
  kind: 'session';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string | null;
  messages?: GuestSessionItemMessage[];
  truncated?: boolean;
};

export type GuestSelectionItem = {
  kind: 'selection';
  action: string;
  sessionId: string;
  directory: string | null;
  messageId: string;
  text: string;
};

export type GuestFileItem = {
  kind: 'file';
  action: string;
  directory: string | null;
  path: string;
  isDirectory: boolean;
};

export type GuestDiffItem = {
  kind: 'diff';
  action: string;
  directory: string | null;
  path: string;
  startLine: number;
  endLine: number;
  side?: 'additions' | 'deletions';
};

export type GuestLinkItem = {
  kind: 'link';
  identifier: string;
  url?: string;
};

export type GuestItem = AttachIssueRequest | GuestMessageItem | GuestSessionItem | GuestSelectionItem | GuestFileItem | GuestDiffItem | GuestLinkItem;

export type GuestActionItem = GuestMessageItem | GuestSessionItem | GuestSelectionItem | GuestFileItem | GuestDiffItem;

export type ActionResultPayload = { ok: true } | { ok: false; error: string };

export const isGuestMessageItem = (item: GuestItem | null): item is GuestMessageItem => (
  item !== null && item.kind === 'message'
);

export const isGuestSessionItem = (item: GuestItem | null): item is GuestSessionItem => (
  item !== null && item.kind === 'session'
);

export const isGuestLinkItem = (item: GuestItem | null): item is GuestLinkItem => (
  item !== null && item.kind === 'link'
);

export const isGuestAttachItem = (item: GuestItem | null): item is AttachIssueRequest => (
  item !== null && (item.kind === undefined || item.kind === 'issue' || item.kind === 'pull')
);

export type ResolveRequest = {
  command: string;
  args: string;
};

export type ResolveResultPayload =
  | { item: AttachIssueRequest | null }
  | { error: string };

export type BadgeRequest = {
  count: number | null;
};

export type OpenCommitRequest = {
  sha: string;
};

export const GUEST_COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

export const isGuestCommitSha = (value: string): boolean => GUEST_COMMIT_SHA.test(value);

export type ResizeRequest = {
  height: number;
};

export type ToastKind = 'info' | 'success' | 'error';

export type ToastRequest = {
  kind: ToastKind;
  message: string;
  copy?: boolean | { text: string };
  dismiss?: boolean;
  persistent?: boolean;
};

export type ComposeRequest = {
  text: string;
  mode?: 'replace' | 'append';
};

export type AttachThreadKind = 'issue' | 'pull';

export type AttachBranches = {
  head: string;
  base: string;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AttachIssueRequest = {
  providerId: string;
  id: string;
  title: string;
  url: string;
  text?: string;
  kind?: AttachThreadKind;
  author?: string;
  branches?: AttachBranches;
  data?: JsonValue;
};

export type StartSessionRequest = AttachIssueRequest & {
  projectId?: string;
  worktree?: GuestSessionWorktree;
  navigation?: 'preserve' | 'open';
};

export const GUEST_TOAST_MAX = 500;
export const GUEST_CLIPBOARD_TEXT_MAX = 32_000;
export const GUEST_COMPOSE_TEXT_MAX = 16_000;
export const GUEST_ATTACH_ID_MAX = 128;
export const GUEST_ATTACH_TITLE_MAX = 200;
export const GUEST_ATTACH_URL_MAX = 2_000;
export const GUEST_ATTACH_TEXT_MAX = 16_000;
export const GUEST_ATTACH_AUTHOR_MAX = 80;
export const GUEST_ATTACH_BRANCH_MAX = 200;
export const GUEST_ATTACH_DATA_MAX = 16_000;
export const GUEST_ACCOUNT_MAX = 200;
export const GUEST_SESSION_MODEL_MAX = 200;
export const GUEST_SESSION_AGENT_MAX = 80;
export const GUEST_SETTING_VALUE_MAX = 2_000;
export const GUEST_REQUEST_PATH_MAX = 2_000;
export const GUEST_REQUEST_BODY_MAX = 64_000;
export const GUEST_REQUEST_RESPONSE_MAX = 8_000_000;
export const GUEST_REQUEST_TIMEOUT_MS = 20_000;
export const GUEST_FILE_PATH_MAX = 1_024;
export const GUEST_FILE_CONTENT_MAX = 2_000_000;
export const GUEST_FILE_LIST_MAX = 2_000;
export const GUEST_GENERATE_PROMPT_MAX = 64_000;
export const GUEST_GENERATE_SYSTEM_MAX = 8_000;
export const GUEST_GENERATE_OUTPUT_TOKENS_MAX = 4_000;
export const GUEST_GENERATE_TEXT_MAX = 256_000;
export const GUEST_GENERATE_TIMEOUT_MS = 960_000;
export const GUEST_GENERATE_LATE_KEEP_MS = 60 * 60_000;
export const GUEST_GENERATE_LATE_MAX = 8;
export const GUEST_ITEM_MESSAGE_TEXT_MAX = 200_000;
export const GUEST_ITEM_SESSION_MAX = 2_000_000;
export const GUEST_BADGE_MAX = 999;
export const GUEST_FRAME_HEIGHT_MAX = 10_000;
export const GUEST_RESOLVE_ERROR_MAX = 500;

export const HOST_REQUEST_ERROR_CODES = [
  'HOST_UNAVAILABLE',
  'HOST_TIMEOUT',
  'HOST_REJECTED',
  'DISCONNECTED',
  'DISABLED',
  'BAD_PATH',
  'NO_INTEGRATION',
  'NO_SERVICE',
  'SERVICE_FAILED',
  'REQUEST_FAILED',
  'RESPONSE_TOO_LARGE',
  'NO_SESSION',
  'SESSION_BUSY',
  'NOT_GRANTED',
  'NO_DIRECTORY',
  'NOT_FOUND',
  'FILE_TOO_LARGE',
  'DENIED',
  'NO_MODEL',
  'MODEL_FAILED',
  'UNSUPPORTED',
] as const;

export const SERVICE_STATUS_VALUES = ['stopped', 'starting', 'ready', 'failed'] as const;

export type ServiceStatus = (typeof SERVICE_STATUS_VALUES)[number];

export type ServiceStatusResult = {
  status: ServiceStatus;
};

export type HostRequestErrorCode = (typeof HOST_REQUEST_ERROR_CODES)[number];

const hostRequestErrorCodeSet: ReadonlySet<string> = new Set(HOST_REQUEST_ERROR_CODES);

export const isHostRequestErrorCode = (value: string): value is HostRequestErrorCode => (
  hostRequestErrorCodeSet.has(value)
);

export const resolveHostRequestErrorCode = (value: string | undefined): HostRequestErrorCode => (
  value && isHostRequestErrorCode(value) ? value : 'HOST_REJECTED'
);

export const isJsonValue = (value: JsonValue | undefined): value is JsonValue => {
  if (value === undefined) return false;
  if (value === null || value === true || value === false) return true;
  if (String(value) === value) return true;
  if (Number(value) === value) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (Object(value) === value) return Object.values(value).every(isJsonValue);
  return false;
};

export const isAttachData = (value: JsonValue | undefined): value is JsonValue => (
  isJsonValue(value) && JSON.stringify(value).length <= GUEST_ATTACH_DATA_MAX
);

const clampBranch = (value: string | undefined): string => (
  value?.trim().slice(0, GUEST_ATTACH_BRANCH_MAX) ?? ''
);

export const clampAttachRequest = (request: AttachIssueRequest): AttachIssueRequest => {
  const id = request.id.trim().slice(0, GUEST_ATTACH_ID_MAX);
  const title = request.title.trim().slice(0, GUEST_ATTACH_TITLE_MAX);
  const url = request.url.trim().slice(0, GUEST_ATTACH_URL_MAX);
  const text = request.text?.trim().slice(0, GUEST_ATTACH_TEXT_MAX);
  const author = request.author?.trim().slice(0, GUEST_ATTACH_AUTHOR_MAX);
  const kind: AttachThreadKind = request.kind === 'pull' ? 'pull' : 'issue';
  const next: AttachIssueRequest = {
    providerId: request.providerId.trim(),
    id,
    title: title || id,
    url,
    kind,
  };
  if (text) {
    next.text = text;
  }
  if (author) {
    next.author = author;
  }
  if (kind === 'pull') {
    const head = clampBranch(request.branches?.head);
    const base = clampBranch(request.branches?.base);
    if (head && base) {
      next.branches = { head, base };
    }
  }
  if (isAttachData(request.data)) {
    next.data = request.data;
  }
  return next;
};

export const clampStartSessionRequest = (request: StartSessionRequest): StartSessionRequest => {
  const next: StartSessionRequest = clampAttachRequest(request);
  if (request.projectId) next.projectId = request.projectId;
  if (request.navigation) next.navigation = request.navigation;
  if (request.worktree) {
    next.worktree = request.worktree;
  }
  return next;
};

export const clampPromptRequest = (request: PromptRequest): PromptRequest => {
  const next: PromptRequest = {
    text: request.text.trim().slice(0, GUEST_COMPOSE_TEXT_MAX),
  };
  if (request.send) {
    next.send = true;
  }
  return next;
};

export const clampBadgeCount = (count: number | null): number | null => {
  if (count === null || !Number.isFinite(count)) return null;
  return Math.min(GUEST_BADGE_MAX, Math.max(0, Math.round(count)));
};

export const clampFrameHeight = (height: number): number => {
  if (!Number.isFinite(height)) return 0;
  return Math.min(GUEST_FRAME_HEIGHT_MAX, Math.max(0, Math.ceil(height)));
};

export const guestFileScope = (path: string): GuestFileScope => (
  path.startsWith('/') || path === '~' || path.startsWith('~/') ? 'filesystem' : 'project'
);

export const isGuestFilePath = (value: string): boolean => (
  value.length > 0
  && value.length <= GUEST_FILE_PATH_MAX
  && !value.includes('\0')
  && !value.includes('\\')
);

export const ATTACH_PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
export const SETTING_KEY = /^[a-z][a-z0-9-]*$/;

export const isGuestRequestPath = (value: string): boolean => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.includes('://')) {
    return false;
  }
  if (value.length > GUEST_REQUEST_PATH_MAX) {
    return false;
  }
  const segments = value.split('/');
  return !segments.some((segment) => segment === '.' || segment === '..');
};


type Envelope = {
  channel: typeof OPENCHAMBER_SDK_CHANNEL;
  v: typeof OPENCHAMBER_SDK_API_VERSION;
};

export type HostReadyMessage = Envelope & { type: 'ready'; payload: HostReadyContext };
export type HostDirectoryMessage = Envelope & { type: 'directory'; payload: { directory: string | null } };
export type HostSessionMessage = Envelope & { type: 'session'; payload: { session: SessionSnapshot | null } };
export type HostConnectionMessage = Envelope & { type: 'connection'; payload: { connection: GuestConnection } };
export type HostSettingsMessage = Envelope & { type: 'settings'; payload: { settings: GuestSettings } };
export type HostSessionLifecycleMessage = Envelope & { type: 'session-lifecycle'; payload: SessionLifecycleEvent };
export type HostItemMessage = Envelope & { type: 'item'; payload: { item: GuestItem | null } };
type HostServiceEventMessage = Envelope & { type: 'service-event'; payload: { topic: string; data: JsonValue } };
export type HostStatusControlEventMessage = Envelope & { type: 'status-control-event'; payload: GuestStatusControlEvent };
export type HostPopoverClosedMessage = Envelope & { type: 'popover-closed'; payload: GuestPopoverClosedEvent };
export type HostResolveMessage = Envelope & { type: 'resolve'; id: string; payload: ResolveRequest };
export type HostActionMessage = Envelope & { type: 'action'; id: string; payload: GuestActionItem };
export type HostFileOpenMessage = Envelope & { type: 'file-open'; payload: FileEditorDocument };
export type HostFileSnapshotMessage = Envelope & { type: 'file-snapshot'; id: string; payload: FileSnapshotRequest };
export type HostFileSavedMessage = Envelope & { type: 'file-saved'; payload: { version: string } };
export type HostGenerateLateMessage = Envelope & { type: 'generate-late'; payload: LateGenerateResult };
export type HostResultMessage = Envelope & { type: 'result'; id: string } & (
  | { ok: true; payload?: HostResultPayload }
  | { ok: false; error: string; code: HostRequestErrorCode }
);

export type HostShellsMessage = Envelope & { type: 'shells'; payload: { subscriptionId: string; snapshot: GuestRunningShellsSnapshot } };

export type HostMicrophoneAudioMessage = Envelope & { type: 'microphone-audio'; payload: { samples: Float32Array<ArrayBuffer> } };
export type HostMicrophoneEndedMessage = Envelope & { type: 'microphone-ended'; payload: { reason: GuestMicrophoneEndReason } };

export type HostMessage =
  | (Envelope & { type: 'workspace'; payload: GuestWorkspaceUpdate })
  | HostShellsMessage
  | HostMicrophoneAudioMessage
  | HostMicrophoneEndedMessage
  | HostReadyMessage
  | HostDirectoryMessage
  | HostSessionMessage
  | HostConnectionMessage
  | HostSettingsMessage
  | HostSessionLifecycleMessage
  | HostItemMessage
  | HostServiceEventMessage
  | HostStatusControlEventMessage
  | HostPopoverClosedMessage
  | HostResolveMessage
  | HostActionMessage
  | HostFileOpenMessage
  | HostFileSnapshotMessage
  | HostFileSavedMessage
  | HostGenerateLateMessage
  | HostResultMessage;

type GuestCall<Type extends string, Payload = never> = Envelope & { type: Type; id: string } & (
  [Payload] extends [never] ? object : { payload: Payload }
);

export type GuestHelloMessage = Envelope & { type: 'hello' };
export type GuestToastMessage = GuestCall<'toast', ToastRequest>;
export type GuestOpenUrlMessage = GuestCall<'open-url', { url: string }>;
export type GuestOpenSurfaceMessage = GuestCall<'open-surface', { surfaceId: string }>;
export type GuestBlockAnswerMessage = GuestCall<'block-answer', { text: string }>;
export type GuestClipboardWriteMessage = GuestCall<'clipboard-write', { text: string }>;
export type GuestComposeMessage = GuestCall<'compose', ComposeRequest>;
export type GuestAttachMessage = GuestCall<'attach', AttachIssueRequest>;
export type GuestStartSessionMessage = GuestCall<'start-session', StartSessionRequest>;
export type GuestPromptMessage = GuestCall<'prompt', PromptRequest>;
export type GuestSessionLinkMessage = GuestCall<'session-link', AttachIssueRequest>;
export type GuestCloseMessage = GuestCall<'close'>;
export type GuestOauthStartMessage = GuestCall<'oauth-start'>;
export type GuestOauthDisconnectMessage = GuestCall<'oauth-disconnect'>;
export type GuestRequestMessage = GuestCall<'request', GuestRequest>;
export type GuestServiceRequestMessage = GuestCall<'service-request', GuestRequest>;
export type GuestServiceStatusMessage = GuestCall<'service-status'>;
export type GuestFileReadMessage = GuestCall<'file-read', FileReadRequest>;
export type GuestFileWriteMessage = GuestCall<'file-write', FileWriteRequest>;
export type GuestFileListMessage = GuestCall<'file-list', FileListRequest>;
export type GuestFileStatMessage = GuestCall<'file-stat', FileStatRequest>;
export type GuestGenerateMessage = GuestCall<'generate', GenerateRequest>;
export type GuestBadgeMessage = GuestCall<'badge', BadgeRequest>;
export type GuestResizeMessage = GuestCall<'resize', ResizeRequest>;
export type GuestOpenCommitMessage = GuestCall<'open-commit', OpenCommitRequest>;
export type GuestStatusControlsMessage = GuestCall<'status-controls', { controls: GuestStatusControl[] }>;
export type GuestPopoverOpenMessage = GuestCall<'popover-open', GuestPopoverRequest>;
export type GuestPopoverCloseMessage = GuestCall<'popover-close', { id: string; reason?: 'closed' | 'escape' }>;
export type GuestPopoverAnchorMessage = GuestCall<'popover-anchor', { id: string; active: boolean }>;
export type GuestResolveResultMessage = Envelope & { type: 'resolve-result'; id: string; payload: ResolveResultPayload };
export type GuestActionResultMessage = Envelope & { type: 'action-result'; id: string; payload: ActionResultPayload };
export type GuestFileSnapshotResultMessage = Envelope & { type: 'file-snapshot-result'; id: string; payload: FileSnapshotResultPayload };
export type GuestFileChangeMessage = Envelope & { type: 'file-change'; payload: FileEditorChange };
export type GuestFileSaveMessage = Envelope & { type: 'file-save' };
export type GuestFileUnsupportedMessage = Envelope & { type: 'file-unsupported' };
export type GuestGenerateLateListenMessage = Envelope & { type: 'generate-late-listen' };

export type GuestShellsSubscribeMessage = GuestCall<'shells-subscribe', GuestShellsSubscription>;
export type GuestShellsUnsubscribeMessage = GuestCall<'shells-unsubscribe', { subscriptionId: string }>;
export type GuestShellOutputMessage = GuestCall<'shell-output', GuestShellOutputRequest>;
export type GuestShellStopMessage = GuestCall<'shell-stop', { shellId: string }>;
export type GuestMicrophoneOpenMessage = GuestCall<'microphone-open', MicrophoneOpenRequest>;
export type GuestMicrophoneCloseMessage = GuestCall<'microphone-close'>;

export type GuestMessage =
  | GuestCall<'workspace-read', GuestWorkspaceQuery>
  | GuestCall<'workspace-subscribe', GuestWorkspaceSubscription>
  | GuestCall<'workspace-unsubscribe', { subscriptionId: string }>
  | GuestShellsSubscribeMessage
  | GuestShellsUnsubscribeMessage
  | GuestShellOutputMessage
  | GuestShellStopMessage
  | GuestMicrophoneOpenMessage
  | GuestMicrophoneCloseMessage
  | GuestCall<'storage', GuestStorageRequest>
  | GuestCall<'open-session', { sessionId: string }>
  | GuestHelloMessage
  | GuestToastMessage
  | GuestOpenUrlMessage
  | GuestOpenSurfaceMessage
  | GuestBlockAnswerMessage
  | GuestClipboardWriteMessage
  | GuestComposeMessage
  | GuestAttachMessage
  | GuestStartSessionMessage
  | GuestPromptMessage
  | GuestSessionLinkMessage
  | GuestCloseMessage
  | GuestOauthStartMessage
  | GuestOauthDisconnectMessage
  | GuestRequestMessage
  | GuestServiceRequestMessage
  | GuestServiceStatusMessage
  | GuestFileReadMessage
  | GuestFileWriteMessage
  | GuestFileListMessage
  | GuestFileStatMessage
  | GuestGenerateMessage
  | GuestBadgeMessage
  | GuestResizeMessage
  | GuestOpenCommitMessage
  | GuestStatusControlsMessage
  | GuestPopoverOpenMessage
  | GuestPopoverCloseMessage
  | GuestPopoverAnchorMessage
  | GuestActionResultMessage
  | GuestResolveResultMessage
  | GuestFileSnapshotResultMessage
  | GuestFileChangeMessage
  | GuestFileSaveMessage
  | GuestFileUnsupportedMessage
  | GuestGenerateLateListenMessage;

const serviceStatusSet: ReadonlySet<string> = new Set(SERVICE_STATUS_VALUES);

export const isServiceStatusResult = (
  value: HostResultPayload | undefined,
): value is ServiceStatusResult => Boolean(value && 'status' in value && serviceStatusSet.has(String(value.status)) && !('body' in value));

export const isGuestRequestResult = (
  value: HostResultPayload | undefined,
): value is GuestRequestResult => Boolean(value && 'status' in value && 'body' in value && Number.isInteger(value.status));

export const isFileReadResult = (
  value: HostResultPayload | undefined,
): value is FileReadResult => Boolean(value && 'content' in value && String(value.content) === value.content);

export const isFileWriteResult = (
  value: HostResultPayload | undefined,
): value is FileWriteResult => Boolean(value && 'written' in value && value.written === true);

export const isFileListResult = (
  value: HostResultPayload | undefined,
): value is FileListResult => Boolean(value && 'entries' in value && Array.isArray(value.entries));

const fileStatKindSet: ReadonlySet<string> = new Set(GUEST_FILE_STAT_KINDS);

export const isFileStatResult = (
  value: HostResultPayload | undefined,
): value is FileStatResult => Boolean(
  value && 'kind' in value && 'size' in value && fileStatKindSet.has(String(value.kind)) && Number.isFinite(value.size),
);

export const isGenerateResult = (
  value: HostResultPayload | undefined,
): value is GenerateResult => Boolean(value && 'text' in value && String(value.text) === value.text && !('status' in value));

const HOST_PUSH_TYPES: ReadonlySet<string> = new Set([
  'workspace',
  'shells',
  'ready', 'directory', 'session', 'connection', 'settings', 'session-lifecycle', 'item', 'resolve', 'action', 'service-event',
  'status-control-event', 'popover-closed',
  'file-open', 'file-snapshot', 'file-saved',
  'generate-late',
  'microphone-audio', 'microphone-ended',
]);

type WireRecord = {
  channel?: unknown;
  v?: unknown;
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  error?: unknown;
  code?: unknown;
  payload?: unknown;
};

const asWireRecord = (data: MessageEvent['data']): WireRecord | null => (
  Object(data) === data ? data : null
);

const isNonEmptyString = (value: WireRecord[keyof WireRecord]): value is string => (
  String(value) === value && value.length > 0
);

const readResultMessage = (wire: WireRecord): HostResultMessage | null => {
  if (!isNonEmptyString(wire.id)) return null;
  if (wire.ok === true) {
    const message: HostResultMessage = {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: wire.id,
      ok: true,
    };
    if (Object(wire.payload) === wire.payload) {
      // SAFETY: a trusted host answered an id this client issued; the per-call
      // guards in host.ts (isStartSessionResult and friends) narrow the payload
      // before it reaches a caller.
      message.payload = wire.payload as HostResultPayload;
    }
    return message;
  }
  if (wire.ok === false && isNonEmptyString(wire.error)) {
    return {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: wire.id,
      ok: false,
      error: wire.error,
      code: resolveHostRequestErrorCode(isNonEmptyString(wire.code) ? wire.code : undefined),
    };
  }
  return null;
};

export const readHostMessage = (data: MessageEvent['data']): HostMessage | null => {
  const wire = asWireRecord(data);
  if (!wire || wire.channel !== OPENCHAMBER_SDK_CHANNEL || wire.v !== OPENCHAMBER_SDK_API_VERSION) return null;
  if (wire.type === 'result') return readResultMessage(wire);
  if (!HOST_PUSH_TYPES.has(String(wire.type)) || Object(wire.payload) !== wire.payload) return null;
  // SAFETY: envelope and discriminant verified above and the sender is the
  // trusted parent frame; protocol.ts asserts these push shapes against the
  // host's own schema at compile time.
  return wire as HostMessage;
};
