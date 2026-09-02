export const NOTIFICATION_INBOX_KIND_KEYS = [
  'sessionFinished',
  'sessionError',
  'sessionSubtask',
  'permissionQuestion',
  'appErrorWarning',
  'info',
  'success',
] as const;

export type NotificationInboxKind = (typeof NOTIFICATION_INBOX_KIND_KEYS)[number];

export type NotificationInboxFilter = {
  sessionFinished: boolean;
  sessionError: boolean;
  sessionSubtask: boolean;
  permissionQuestion: boolean;
  appErrorWarning: boolean;
  info: boolean;
  success: boolean;
};

export const DEFAULT_NOTIFICATION_INBOX_FILTER = {
  sessionFinished: true,
  sessionError: true,
  sessionSubtask: false,
  permissionQuestion: true,
  appErrorWarning: true,
  info: false,
  success: false,
} satisfies NotificationInboxFilter;

const isPlainObject = (value: unknown): value is object => (
  value != null && !Array.isArray(value) && Object(value) === value
);

const readBoolean = (source: object, key: NotificationInboxKind): boolean | undefined => {
  const value = Reflect.get(source, key);
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
};

export const parseNotificationInboxFilter = (value: unknown): NotificationInboxFilter | null => {
  if (!isPlainObject(value)) return null;
  let found = false;
  let next: NotificationInboxFilter = { ...DEFAULT_NOTIFICATION_INBOX_FILTER };
  for (const key of NOTIFICATION_INBOX_KIND_KEYS) {
    const parsed = readBoolean(value, key);
    if (parsed == null) continue;
    next = { ...next, [key]: parsed };
    found = true;
  }
  return found ? next : null;
};

export const isInboxKindEnabled = (
  filter: NotificationInboxFilter,
  kind: NotificationInboxKind,
  inboxEnabled = true,
): boolean => inboxEnabled && filter[kind] === true;
