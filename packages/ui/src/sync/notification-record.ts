import { Children, isValidElement, type ReactNode } from 'react';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import type { NotificationInboxKind } from '@/lib/notificationInboxFilter';
import { isSessionIdentityLabel } from './notification-session-context';

export type NotificationSeverity = 'error' | 'warning' | 'info' | 'success';
export type NotificationSource = 'session' | 'subtask' | 'toast' | 'permission' | 'question';

export type NotificationAction = {
  type: 'open-session';
  sessionId: string;
  directory: string;
};

export type NotificationSessionError = {
  name: string | null;
  message: string | null;
};

export type NotificationRecord = {
  id: string;
  runtimeKey: string;
  time: number;
  read: boolean;
  title: string;
  body: string;
  severity: NotificationSeverity;
  source: NotificationSource;
  session?: string;
  directory?: string;
  action?: NotificationAction;
  error?: NotificationSessionError;
  dedupeKey: string;
  count: number;
};

export type NotificationListsByRuntime = {
  [runtimeKey: string]: NotificationRecord[];
};

export const MAX_NOTIFICATIONS = 500;
export const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const NOTIFICATION_DEDUPE_WINDOW_MS = 60_000;
const NOTIFICATION_TEXT_MAX_LENGTH = 500;

const SECRET_TOKEN_PATTERN = /\b(?:sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g;
const BEARER_PATTERN = /Bearer\s+\S+/gi;

type SessionAttentionInput = {
  type: 'turn-complete' | 'error';
  directory?: string;
  session?: string;
  sessionTitle?: string;
  projectLabel?: string;
  subtask?: boolean;
  time?: number;
  viewed?: boolean;
  error?: { name?: string | null; message?: string | null; code?: string };
};

export const formatSessionNotificationContext = (
  sessionTitle?: string,
  projectLabel?: string,
): string => {
  const title = nonempty(sessionTitle) ?? '';
  const usableProject = nonempty(projectLabel);
  const project = usableProject && !isSessionIdentityLabel(usableProject) ? usableProject : '';
  if (title && project && title !== project) return `${title} · ${project}`;
  return title || project;
};

type NotificationDraft = {
  id?: string;
  title: string;
  body?: string;
  severity: NotificationSeverity;
  source: NotificationSource;
  session?: string;
  directory?: string;
  action?: NotificationAction;
  dedupeKey?: string;
  read?: boolean;
  time?: number;
  runtimeKey?: string;
};

export type NotificationAppendInput = SessionAttentionInput | NotificationDraft;

const isSessionAttentionInput = (value: NotificationAppendInput): value is SessionAttentionInput => (
  'type' in value && (value.type === 'turn-complete' || value.type === 'error')
);

const createNotificationId = (): string => crypto.randomUUID();

const nonempty = (value: string | undefined): string | undefined => {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const flattenNotificationText = (value: ReactNode): string => {
  if (value == null || value === true || value === false) return '';
  return Children.toArray(value)
    .map((child) => {
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return flattenNotificationText(child.props.children);
      }
      return String(child);
    })
    .join(' ')
    .trim();
};

const redactSecrets = (text: string): string => {
  const withoutTokens = text
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_TOKEN_PATTERN, '[REDACTED]');
  const trimmed = withoutTokens.trim();
  if (/^https?:\/\//i.test(trimmed)) return redactSensitiveUrl(trimmed);
  return withoutTokens;
};

const clampNotificationText = (text: string): string => {
  if (text.length <= NOTIFICATION_TEXT_MAX_LENGTH) return text;
  return `${text.slice(0, NOTIFICATION_TEXT_MAX_LENGTH)}...`;
};

export const sanitizeNotificationText = (value: ReactNode): string => {
  const text = flattenNotificationText(value).trim();
  if (!text) return '';
  return clampNotificationText(redactSecrets(text));
};

export const inboxKindOf = (notification: NotificationRecord): NotificationInboxKind => {
  if (notification.source === 'subtask') return 'sessionSubtask';
  if (notification.source === 'session') {
    return notification.severity === 'error' ? 'sessionError' : 'sessionFinished';
  }
  if (notification.source === 'permission' || notification.source === 'question') {
    return 'permissionQuestion';
  }
  if (notification.severity === 'error' || notification.severity === 'warning') {
    return 'appErrorWarning';
  }
  if (notification.severity === 'success') return 'success';
  return 'info';
};

const isPlainObject = (value: unknown): value is object => (
  value != null && !Array.isArray(value) && Object(value) === value
);

const readTrimmedString = (source: object, key: string): string | undefined => {
  const value = Reflect.get(source, key);
  const text = String(value);
  if (value !== text) return undefined;
  return nonempty(text);
};

const readFiniteNumber = (source: object, key: string): number | null => {
  const value = Reflect.get(source, key);
  const numeric = Number(value);
  if (value !== numeric || !Number.isFinite(numeric)) return null;
  return numeric;
};

const readBoolean = (source: object, key: string): boolean | undefined => {
  const value = Reflect.get(source, key);
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
};

const parseSeverity = (value: unknown): NotificationSeverity | null => {
  if (value === 'error' || value === 'warning' || value === 'info' || value === 'success') return value;
  return null;
};

const parseSource = (value: unknown): NotificationSource | null => {
  if (
    value === 'session'
    || value === 'subtask'
    || value === 'toast'
    || value === 'permission'
    || value === 'question'
  ) return value;
  return null;
};

const parseAction = (value: unknown): NotificationAction | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (Reflect.get(value, 'type') !== 'open-session') return undefined;
  const sessionId = readTrimmedString(value, 'sessionId');
  const directory = readTrimmedString(value, 'directory');
  if (!sessionId || !directory) return undefined;
  return { type: 'open-session', sessionId, directory };
};

const parseSessionError = (value: unknown): NotificationSessionError | undefined => {
  if (!isPlainObject(value)) return undefined;
  const name = readTrimmedString(value, 'name') ?? null;
  const message = sanitizeNotificationText(readTrimmedString(value, 'message') ?? '')
    || sanitizeNotificationText(readTrimmedString(value, 'code') ?? '')
    || null;
  if (!name && !message) return undefined;
  return { name, message };
};

const attachOptionalIdentity = (
  record: NotificationRecord,
  session: string | undefined,
  directory: string | undefined,
  action: NotificationAction | undefined,
  error?: NotificationSessionError,
): NotificationRecord => {
  if (session) record.session = session;
  if (directory) record.directory = directory;
  if (action) record.action = action;
  if (error) record.error = error;
  return record;
};

export const parseNotificationRecord = (value: unknown, fallbackRuntimeKey: string): NotificationRecord | null => {
  if (!isPlainObject(value)) return null;

  const legacyTypeValue = Reflect.get(value, 'type');
  const legacyType = legacyTypeValue === 'turn-complete' || legacyTypeValue === 'error' ? legacyTypeValue : null;
  const source = parseSource(Reflect.get(value, 'source')) ?? (legacyType ? 'session' : null);
  if (!source) return null;

  const time = readFiniteNumber(value, 'time');
  if (time == null) return null;

  const severity = parseSeverity(Reflect.get(value, 'severity'))
    ?? (legacyType === 'error' ? 'error' : 'info');

  const error = parseSessionError(Reflect.get(value, 'error'));
  const title = sanitizeNotificationText(readTrimmedString(value, 'title') ?? '')
    || (legacyType === 'error' ? 'Session error' : '')
    || (legacyType === 'turn-complete' ? 'Session finished' : '');
  const body = sanitizeNotificationText(readTrimmedString(value, 'body') ?? '')
    || sanitizeNotificationText(error?.message ?? '');

  const countValue = readFiniteNumber(value, 'count');
  const count = countValue != null && Number.isSafeInteger(countValue) && countValue > 0 ? countValue : 1;
  const session = readTrimmedString(value, 'session');
  const directory = readTrimmedString(value, 'directory');
  const action = parseAction(Reflect.get(value, 'action'))
    ?? ((source === 'session' || source === 'subtask') && session && directory
      ? { type: 'open-session' as const, sessionId: session, directory }
      : undefined);
  const read = readBoolean(value, 'read') ?? readBoolean(value, 'viewed') ?? false;
  if (!title && !body) return null;

  return attachOptionalIdentity({
    id: readTrimmedString(value, 'id') ?? createNotificationId(),
    runtimeKey: readTrimmedString(value, 'runtimeKey') ?? fallbackRuntimeKey,
    time,
    read,
    title,
    body,
    severity,
    source,
    dedupeKey: readTrimmedString(value, 'dedupeKey')
      ?? `${source}:${severity}:${session ?? ''}:${directory ?? ''}:${title}:${body}`,
    count,
  }, session, directory, action, error);
};

export const normalizeNotificationAppend = (
  input: NotificationAppendInput,
  runtimeKey: string,
): NotificationRecord => {
  if (isSessionAttentionInput(input)) {
    const session = nonempty(input.session);
    const directory = nonempty(input.directory);
    const action = session && directory
      ? { type: 'open-session' as const, sessionId: session, directory }
      : undefined;
    const context = formatSessionNotificationContext(input.sessionTitle, input.projectLabel);
    const error = parseSessionError(input.error);
    const errorBody = error?.message ?? '';
    const body = context && errorBody ? `${context}\n${errorBody}` : context || errorBody;
    const source: NotificationSource = input.subtask === true ? 'subtask' : 'session';
    return attachOptionalIdentity({
      id: createNotificationId(),
      runtimeKey,
      time: input.time != null && Number.isFinite(input.time) ? input.time : Date.now(),
      read: input.viewed === true,
      title: input.subtask === true
        ? (input.type === 'error' ? 'Subtask error' : 'Subtask finished')
        : (input.type === 'error' ? 'Session error' : 'Session finished'),
      body,
      severity: input.type === 'error' ? 'error' : 'info',
      source,
      dedupeKey: `${source}:${input.type}:${session ?? ''}:${directory ?? ''}`,
      count: 1,
    }, session, directory, action, error);
  }

  const session = nonempty(input.session);
  const directory = nonempty(input.directory);
  const title = sanitizeNotificationText(input.title);
  const body = sanitizeNotificationText(input.body);
  return attachOptionalIdentity({
    id: nonempty(input.id) ?? createNotificationId(),
    runtimeKey: nonempty(input.runtimeKey) ?? runtimeKey,
    time: input.time != null && Number.isFinite(input.time) ? input.time : Date.now(),
    read: input.read === true,
    title,
    body,
    severity: input.severity,
    source: input.source,
    dedupeKey: nonempty(input.dedupeKey)
      ?? `${input.source}:${input.severity}:${session ?? ''}:${directory ?? ''}:${title}:${body}`,
    count: 1,
  }, session, directory, input.action);
};

const assignUniqueNotificationId = (
  list: NotificationRecord[],
  incoming: NotificationRecord,
): NotificationRecord => (
  list.some((item) => item.id === incoming.id)
    ? { ...incoming, id: createNotificationId() }
    : incoming
);

const uniquifyNotificationIds = (list: NotificationRecord[]): NotificationRecord[] => {
  const seen = new Set<string>();
  return list.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    const reminted = { ...item, id: createNotificationId() };
    seen.add(reminted.id);
    return reminted;
  });
};

export const pruneNotifications = (list: NotificationRecord[]): NotificationRecord[] => {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS;
  const pruned = list.filter((notification) => notification.time >= cutoff);
  const capped = pruned.length <= MAX_NOTIFICATIONS
    ? pruned
    : [...pruned].sort((left, right) => left.time - right.time).slice(-MAX_NOTIFICATIONS);
  return uniquifyNotificationIds(capped);
};

const appendWithUniqueId = (
  list: NotificationRecord[],
  incoming: NotificationRecord,
): NotificationRecord[] => [...list, assignUniqueNotificationId(list, incoming)];

export const mergeDedupedNotification = (
  list: NotificationRecord[],
  incoming: NotificationRecord,
): NotificationRecord[] => {
  if (incoming.read) return appendWithUniqueId(list, incoming);
  const windowStart = incoming.time - NOTIFICATION_DEDUPE_WINDOW_MS;
  const existingIndex = list.findIndex((candidate) => (
    !candidate.read
    && candidate.runtimeKey === incoming.runtimeKey
    && candidate.dedupeKey === incoming.dedupeKey
    && candidate.time >= windowStart
  ));
  if (existingIndex < 0) return appendWithUniqueId(list, incoming);

  const existing = list[existingIndex];
  const next = [...list];
  next[existingIndex] = {
    ...existing,
    title: incoming.title || existing.title,
    body: incoming.body || existing.body,
    time: incoming.time,
    count: existing.count + 1,
    action: incoming.action ?? existing.action,
    session: incoming.session ?? existing.session,
    directory: incoming.directory ?? existing.directory,
  };
  return next;
};

const parseNotificationListsByRuntime = (
  value: unknown,
  fallbackRuntimeKey: string,
): NotificationListsByRuntime => {
  const next: NotificationListsByRuntime = {};
  if (!isPlainObject(value)) return next;
  for (const runtimeKey of Object.keys(value)) {
    const list = Reflect.get(value, runtimeKey);
    if (!runtimeKey || !Array.isArray(list)) continue;
    const parsed = list
      .map((item) => parseNotificationRecord(item, runtimeKey || fallbackRuntimeKey))
      .filter((item): item is NotificationRecord => item != null);
    next[runtimeKey] = pruneNotifications(parsed);
  }
  return next;
};

export const parseNotificationPersistState = (
  persisted: unknown,
  runtimeKey: string,
): { listsByRuntime: NotificationListsByRuntime; list: NotificationRecord[] } => {
  const listsByRuntime: NotificationListsByRuntime = {};
  if (!isPlainObject(persisted)) {
    return { listsByRuntime, list: [] };
  }

  const fromMap = parseNotificationListsByRuntime(Reflect.get(persisted, 'listsByRuntime'), runtimeKey);
  Object.assign(listsByRuntime, fromMap);
  if (Object.keys(listsByRuntime).length === 0) {
    const legacyList = Reflect.get(persisted, 'list');
    if (Array.isArray(legacyList)) {
      listsByRuntime[runtimeKey] = pruneNotifications(
        legacyList
          .map((item) => parseNotificationRecord(item, runtimeKey))
          .filter((item): item is NotificationRecord => item != null),
      );
    }
  }

  return {
    listsByRuntime,
    list: listsByRuntime[runtimeKey] ?? [],
  };
};
