import type { ControlOptions } from './service.js';
import type { TextMessage } from './session-text-messages.js';
import type { JsonValue } from '../shared/json-values.js';

export type { SessionMetadata as StoredSessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

export interface PendingPermission {
  directory?: JsonValue | undefined;
  id?: JsonValue | undefined;
  action?: JsonValue | undefined;
  resources?: JsonValue | undefined;
}

export interface PendingRequests {
  forms: { id?: JsonValue | undefined; title?: JsonValue | undefined; fields?: JsonValue | undefined }[];
  pages: { id?: JsonValue | undefined; title?: JsonValue | undefined }[];
  permissions: PendingPermission[];
}

export type WaitingRequest =
  | { kind: 'page'; title: string }
  | { kind: 'form'; title: string; questions: string[] }
  | { kind: 'permission'; action: string; resources: string[] };

export type PublicSessionStatus = { type: 'idle' | 'busy' } | { type: 'waiting'; waitingOn: WaitingRequest[] };

export interface SessionActionResult {
  sessionId: string;
  directory: string;
  projectId?: string;
  title?: string;
  worktree?: object;
  promptDispatched: boolean;
  baselineAssistantMessageId?: string;
  baselineIdleRecordId?: string | null;
  lastAssistantMessage?: TextMessage | null;
  waitingOn?: WaitingRequest[];
  note?: string;
}

export interface SessionStatusResult extends Pick<SessionActionResult, 'sessionId' | 'directory'> {
  sessionStatus: PublicSessionStatus;
}

export interface SessionMessagesResult extends SessionStatusResult {
  role: string;
  messages: TextMessage[];
}

export interface SessionReadResults {
  'session.messages': SessionMessagesResult;
  'session.status': SessionStatusResult;
}

export type SessionReadAction = keyof SessionReadResults;

export interface SessionControlExecute {
  (action: 'session.create' | 'session.send', input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionActionResult>;
  <Action extends SessionReadAction>(action: Action, input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionReadResults[Action]>;
}

export interface ControlInput {
  name?: unknown;
  title?: unknown;
  model?: unknown;
  agent?: unknown;
  variant?: unknown;
  daily?: unknown;
  weekly?: unknown;
  once?: unknown;
  cron?: unknown;
  time?: unknown;
  timezone?: unknown;
  targetSessionId?: unknown;
  goal?: unknown;
  goalTokenBudget?: unknown;
  runInWorktree?: unknown;
  cleanupWorktree?: unknown;
  baseBranch?: unknown;
  disabled?: unknown;
  taskId?: unknown;
  wait?: unknown;
  returnResult?: unknown;
  ownWork?: unknown;
  timeout?: unknown;
  lastAssistant?: unknown;
  pullRequest?: unknown;
  worktree?: unknown;
  branch?: unknown;
  startRef?: unknown;
  setUpstream?: unknown;
  messageId?: unknown;
  withStatus?: unknown;
  inWork?: unknown;
  busy?: unknown;
  mine?: unknown;
  leads?: unknown;
  brief?: unknown;
  edits?: unknown;
  strands?: unknown;
  needsYou?: unknown;
  now?: unknown;
  news?: unknown;
  suggestions?: unknown;
  leadId?: unknown;
  all?: unknown;
  children?: unknown;
  query?: unknown;
  provider?: unknown;
  providerId?: unknown;
  offset?: unknown;
  limit?: unknown;
  tabId?: unknown;
  viewport?: unknown;
  ref?: unknown;
  selector?: unknown;
  text?: unknown;
  to?: unknown;
  toSelector?: unknown;
  dialog?: unknown;
  readonly value?: unknown;
  submit?: unknown;
  direction?: unknown;
  key?: unknown;
  gone?: unknown;
  timeoutMs?: unknown;
  paths?: unknown;
  showWhenFocused?: unknown;
  link?: unknown;
  identifier?: unknown;
  existingBranch?: unknown;
  carry?: unknown;
  role?: unknown;
  last?: unknown;
  html?: unknown;
  ui?: unknown;
  awaitAnswer?: unknown;
  answerLater?: unknown;
  share?: unknown;
  reason?: unknown;
  placeholder?: unknown;
  program?: unknown;
  inputs?: unknown;
  saved?: unknown;
  projectId?: unknown;
  directory?: unknown;
  kind?: unknown;
  id?: unknown;
  body?: unknown;
  completed?: unknown;
  planId?: unknown;
  dependsOn?: unknown;
  sessionId?: unknown;
  expected?: unknown;
  ready?: unknown;
  source?: unknown;
  args?: unknown;
  url?: unknown;
  waitId?: unknown;
  prompt?: unknown;
  count?: unknown;
  aspect?: unknown;
  resolution?: unknown;
  images?: unknown;
  path?: unknown;
  readonly label?: unknown;
  maxBytes?: unknown;
}

export interface ActionContext {
  directory?: string | null | undefined;
  signal?: AbortSignal | undefined;
}
