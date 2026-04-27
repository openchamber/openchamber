export type HarnessBackendId = string;
export type HarnessSessionId = string;
export type HarnessMessageId = string;
export type HarnessPartId = string;
export type HarnessTurnId = string;
export type HarnessItemId = string;
export type HarnessRequestId = string;

export type HarnessCapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'error';

export interface HarnessBackendDescriptor {
  id: HarnessBackendId;
  label: string;
  available: boolean;
  comingSoon?: boolean;
  capabilities: HarnessBackendCapabilities;
}

export interface HarnessBackendCapabilities {
  chat: boolean;
  sessions: boolean;
  models: boolean;
  commands?: boolean;
  shell?: boolean;
  auth?: boolean;
  approvals?: boolean;
  providers?: boolean;
  config?: boolean;
  skills?: boolean;
}

export interface HarnessAdapterCapabilities extends HarnessBackendCapabilities {
  events: boolean;
  blockingRequests?: boolean;
  fork?: boolean;
  rollback?: boolean;
}

export interface HarnessProviderSnapshotInput {
  backendId: HarnessBackendId;
  directory?: string | null;
}

export interface HarnessProviderSnapshot {
  backendId: HarnessBackendId;
  label: string;
  enabled: boolean;
  installed?: boolean;
  version?: string | null;
  auth?: HarnessProviderAuthStatus;
  checkedAt?: string;
  capabilities: HarnessBackendCapabilities;
  models: HarnessProviderModel[];
  interactionModes?: HarnessProviderOptionChoice[];
  commands?: HarnessProviderCommand[];
  raw?: unknown;
}

export interface HarnessProviderAuthStatus {
  status: 'authenticated' | 'unauthenticated' | 'unknown' | 'error';
  message?: string;
}

export interface HarnessProviderModel {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
  optionDescriptors?: HarnessProviderOptionDescriptor[];
  raw?: unknown;
}

export interface HarnessProviderCommand {
  id: string;
  label: string;
  description?: string;
  inputHint?: string;
  raw?: unknown;
}

export type HarnessProviderOptionDescriptor =
  | HarnessProviderSelectOptionDescriptor
  | HarnessProviderBooleanOptionDescriptor;

export interface HarnessProviderSelectOptionDescriptor {
  id: string;
  label: string;
  description?: string;
  type: 'select';
  options: HarnessProviderOptionChoice[];
  currentValue?: string;
  promptInjectedValues?: string[];
}

export interface HarnessProviderBooleanOptionDescriptor {
  id: string;
  label: string;
  description?: string;
  type: 'boolean';
  currentValue?: boolean;
}

export interface HarnessProviderOptionChoice {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export type HarnessProviderOptionSelection =
  | { id: string; value: string }
  | { id: string; value: boolean };

export interface HarnessRunConfig {
  backendId: HarnessBackendId;
  model?: HarnessModelSelection;
  interactionMode?: string;
  runtimeMode?: string;
  options?: HarnessProviderOptionSelection[];
}

export interface HarnessModelSelection {
  backendId: HarnessBackendId;
  modelId: string;
  label?: string;
  raw?: unknown;
}

export interface HarnessSession {
  id: HarnessSessionId;
  backendId: HarnessBackendId;
  title: string;
  directory?: string | null;
  parentId?: HarnessSessionId | null;
  time: {
    created: number;
    updated?: number;
    archived?: number;
  };
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface HarnessMessageRecord {
  info: HarnessMessage;
  parts: HarnessPart[];
}

export interface HarnessThreadSnapshot {
  session: HarnessSession;
  messages: HarnessMessageRecord[];
  status?: HarnessSessionStatus;
  binding?: HarnessSessionBinding | null;
  raw?: unknown;
}

export interface HarnessMessage {
  id: HarnessMessageId;
  sessionId: HarnessSessionId;
  role: 'user' | 'assistant' | 'system';
  time: {
    created: number;
    completed?: number;
  };
  finish?: string;
  attribution?: HarnessMessageAttribution;
  raw?: unknown;
}

export interface HarnessMessageAttribution {
  backendId?: HarnessBackendId;
  providerId?: string;
  modelId?: string;
  modelLabel?: string;
  modeId?: string;
  modeLabel?: string;
  effortId?: string;
  effortLabel?: string;
}

export type HarnessPart =
  | HarnessTextPart
  | HarnessReasoningPart
  | HarnessToolPart
  | HarnessAttachmentPart
  | HarnessLinkedSessionPart
  | HarnessCustomPart;

export interface HarnessBasePart {
  id: HarnessPartId;
  sessionId: HarnessSessionId;
  messageId: HarnessMessageId;
  raw?: unknown;
}

export interface HarnessTextPart extends HarnessBasePart {
  kind: 'text';
  text: string;
  synthetic?: boolean;
}

export interface HarnessReasoningPart extends HarnessBasePart {
  kind: 'reasoning';
  text: string;
}

export interface HarnessToolPart extends HarnessBasePart {
  kind: 'tool';
  tool: HarnessToolActivity;
}

export interface HarnessAttachmentPart extends HarnessBasePart {
  kind: 'attachment';
  attachment: HarnessAttachment;
}

export interface HarnessLinkedSessionPart extends HarnessBasePart {
  kind: 'linked-session';
  linkedSessionId: HarnessSessionId;
  label?: string;
}

export interface HarnessCustomPart extends HarnessBasePart {
  kind: 'custom';
  content: unknown;
}

export interface HarnessAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  path?: string;
  content?: string;
  raw?: unknown;
}

export interface HarnessToolActivity {
  id: string;
  name: string;
  label?: string;
  category: 'shell' | 'edit' | 'search' | 'fetch' | 'task' | 'custom';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  input?: unknown;
  output?: string;
  error?: string;
  files?: HarnessToolFileChange[];
  diff?: string;
  linkedSessionId?: HarnessSessionId;
  startedAt?: number;
  endedAt?: number;
  raw?: unknown;
}

export interface HarnessToolFileChange {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface HarnessSessionBinding {
  sessionId: HarnessSessionId;
  backendId: HarnessBackendId;
  directory?: string | null;
  status?: HarnessSessionRuntimeStatus;
  resumeCursor?: unknown | null;
  runtimePayload?: unknown | null;
  runtimeMode?: string;
  lastSeenAt: string;
}

export type HarnessSessionRuntimeStatus = 'idle' | 'running' | 'queued' | 'blocked' | 'exited' | 'error';

export interface HarnessSessionStatus {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  status: HarnessSessionRuntimeStatus;
  message?: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface HarnessBlockingRequest {
  id: HarnessRequestId;
  sessionId: HarnessSessionId;
  backendId: HarnessBackendId;
  kind: 'permission' | 'question' | 'user-input' | 'custom';
  title?: string;
  message?: string;
  options?: HarnessBlockingRequestOption[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface HarnessBlockingRequestOption {
  id: string;
  label: string;
  description?: string;
}

export interface CreateHarnessSessionInput {
  backendId?: HarnessBackendId;
  directory?: string | null;
  parentId?: HarnessSessionId | null;
  title?: string;
  runConfig?: HarnessRunConfig;
  metadata?: Record<string, unknown>;
}

export interface ListHarnessSessionsInput {
  backendId?: HarnessBackendId;
  directory?: string | null;
  includeArchived?: boolean;
}

export interface ReadHarnessThreadInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
}

export interface SendHarnessMessageInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
  text: string;
  messageId?: HarnessMessageId;
  attachments?: HarnessAttachment[];
  runConfig?: HarnessRunConfig;
}

export interface SendHarnessCommandInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
  commandId: string;
  arguments?: string;
  messageId?: HarnessMessageId;
  runConfig?: HarnessRunConfig;
}

export interface AbortHarnessSessionInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
}

export interface StopHarnessSessionInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
}

export interface ForkHarnessSessionInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
  messageId?: HarnessMessageId;
}

export interface RollbackHarnessThreadInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  directory?: string | null;
  messageId?: HarnessMessageId;
  partId?: HarnessPartId;
}

export interface ReplyBlockingRequestInput {
  sessionId: HarnessSessionId;
  backendId?: HarnessBackendId;
  requestId: HarnessRequestId;
  response: unknown;
}

export interface SubscribeHarnessEventsInput {
  backendId?: HarnessBackendId;
  sessionId?: HarnessSessionId;
  directory?: string | null;
  cursor?: string | null;
  signal?: AbortSignal;
}

export interface HarnessAdapter {
  id: HarnessBackendId;
  capabilities: HarnessAdapterCapabilities;
  getProviderSnapshot(input: HarnessProviderSnapshotInput): Promise<HarnessProviderSnapshot>;
  createSession(input: CreateHarnessSessionInput): Promise<HarnessSession>;
  listSessions(input: ListHarnessSessionsInput): Promise<HarnessSession[]>;
  hasSession(input: { sessionId: HarnessSessionId; directory?: string | null }): Promise<boolean>;
  readThread(input: ReadHarnessThreadInput): Promise<HarnessThreadSnapshot>;
  sendMessage(input: SendHarnessMessageInput): Promise<void>;
  sendCommand?(input: SendHarnessCommandInput): Promise<void>;
  abortSession(input: AbortHarnessSessionInput): Promise<void>;
  stopSession(input: StopHarnessSessionInput): Promise<void>;
  forkSession?(input: ForkHarnessSessionInput): Promise<HarnessSession>;
  rollbackThread?(input: RollbackHarnessThreadInput): Promise<HarnessThreadSnapshot>;
  replyBlockingRequest?(input: ReplyBlockingRequestInput): Promise<void>;
  streamEvents(input: SubscribeHarnessEventsInput): AsyncIterable<HarnessRuntimeEvent>;
}

export interface HarnessService {
  listBackends(): Promise<HarnessBackendDescriptor[]>;
  getProviderSnapshot(input: HarnessProviderSnapshotInput): Promise<HarnessProviderSnapshot>;
  createSession(input: CreateHarnessSessionInput): Promise<HarnessSession>;
  listSessions(input: ListHarnessSessionsInput): Promise<HarnessSession[]>;
  resolveSessionBinding(sessionId: HarnessSessionId): Promise<HarnessSessionBinding | null>;
  sendMessage(input: SendHarnessMessageInput): Promise<void>;
  sendCommand(input: SendHarnessCommandInput): Promise<void>;
  abortSession(input: AbortHarnessSessionInput): Promise<void>;
  stopSession(input: StopHarnessSessionInput): Promise<void>;
  replyBlockingRequest(input: ReplyBlockingRequestInput): Promise<void>;
  streamEvents(input: SubscribeHarnessEventsInput): AsyncIterable<HarnessRuntimeEvent>;
}

export interface HarnessRuntimeEvent {
  eventId: string;
  backendId: HarnessBackendId;
  sessionId: HarnessSessionId;
  createdAt: string;
  type: HarnessRuntimeEventType;
  turnId?: HarnessTurnId;
  itemId?: HarnessItemId;
  requestId?: HarnessRequestId;
  providerRefs?: HarnessRuntimeProviderRefs;
  payload: unknown;
  raw?: HarnessRuntimeRawEvent;
}

export interface HarnessRuntimeProviderRefs {
  providerTurnId?: string;
  providerItemId?: string;
  providerRequestId?: string;
}

export interface HarnessRuntimeRawEvent {
  source: string;
  method?: string;
  messageType?: string;
  payload: unknown;
}

export type HarnessRuntimeEventType =
  | 'session.started'
  | 'session.configured'
  | 'session.state.changed'
  | 'session.exited'
  | 'thread.started'
  | 'thread.state.changed'
  | 'thread.metadata.updated'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.aborted'
  | 'turn.plan.updated'
  | 'turn.diff.updated'
  | 'item.started'
  | 'item.updated'
  | 'item.completed'
  | 'content.delta'
  | 'request.opened'
  | 'request.resolved'
  | 'user-input.requested'
  | 'user-input.resolved'
  | 'tool.progress'
  | 'tool.summary'
  | 'model.rerouted'
  | 'runtime.warning'
  | 'runtime.error';

export type HarnessEvent = HarnessRuntimeEvent;

export type ChatSyncEvent =
  | { type: 'session.upserted'; session: HarnessSession }
  | { type: 'session.removed'; sessionId: HarnessSessionId }
  | { type: 'session.status.updated'; sessionId: HarnessSessionId; status: HarnessSessionStatus }
  | { type: 'message.upserted'; message: HarnessMessage }
  | { type: 'message.removed'; sessionId: HarnessSessionId; messageId: HarnessMessageId }
  | { type: 'part.upserted'; part: HarnessPart }
  | {
      type: 'part.removed';
      sessionId: HarnessSessionId;
      messageId: HarnessMessageId;
      partId: HarnessPartId;
    }
  | {
      type: 'part.delta';
      sessionId: HarnessSessionId;
      messageId: HarnessMessageId;
      partId: HarnessPartId;
      field: string;
      delta: string;
    }
  | { type: 'blocking-request.opened'; request: HarnessBlockingRequest }
  | { type: 'blocking-request.resolved'; sessionId: HarnessSessionId; requestId: HarnessRequestId };

export interface BackendControlSurface {
  backendId: HarnessBackendId;
  providerSnapshot?: HarnessProviderSnapshot | null;
  modeSelector?: BackendModeSelectorSurface | null;
  modelSelector?: BackendModelSelectorSurface | null;
  effortSelector?: BackendEffortSelectorSurface | null;
  commandSelector?: BackendCommandSelectorSurface | null;
  capabilities?: HarnessBackendCapabilities;
}

export interface BackendControlSurfaceOption {
  id: string;
  label: string;
  description?: string;
  available?: boolean;
  color?: string;
}

export interface BackendModeSelectorSurface {
  kind: 'agent' | 'mode';
  label: string;
  items: BackendControlSurfaceOption[];
}

export interface BackendModelSelectorSurface {
  label: string;
  source: 'providers' | 'backend' | 'provider-snapshot';
  options?: BackendControlSurfaceOption[];
  providerId?: string;
  defaultOptionId?: string | null;
}

export interface BackendEffortSelectorSurface {
  label: string;
  source: 'model-variants' | 'backend' | 'provider-option';
  optionId?: string;
  options: BackendControlSurfaceOption[];
  defaultOptionId?: string | null;
}

export interface BackendCommandSurfaceItem {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  template?: string;
  executionMode?: 'session-command' | 'prompt-text';
}

export interface BackendCommandSelectorSurface {
  source: 'config' | 'backend';
  items: BackendCommandSurfaceItem[];
}
