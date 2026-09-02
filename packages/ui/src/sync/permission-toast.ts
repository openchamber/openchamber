import type { PermissionRequest } from '@/types/permission';
import type { NotificationAction, NotificationSource } from '@/sync/notification-store';

type PermissionToastOptions = {
  permission: PermissionRequest;
  directory: string;
  isViewed: boolean;
  pendingIds: Set<string>;
  title: string;
  actionLabel: string;
  fallbackDescription: string;
  show: (title: string, options: {
    id: string;
    description: string;
    action: { label: string; onClick: () => void };
    source: NotificationSource;
    session: string;
    directory: string;
    actionRecord: NotificationAction;
    dedupeKey: string;
  }) => void;
  openSession: (sessionId: string, directory: string) => void;
};

export const getPermissionToastKey = (sessionId?: string, requestId?: string) => {
  if (!sessionId || !requestId) return null;
  return `${sessionId}:${requestId}`;
};

export const showPermissionNeededToast = ({
  permission,
  directory,
  isViewed,
  pendingIds,
  title,
  actionLabel,
  fallbackDescription,
  show,
  openSession,
}: PermissionToastOptions): boolean => {
  const key = getPermissionToastKey(permission.sessionID, permission.id);
  if (isViewed || !key || pendingIds.has(key)) return false;

  pendingIds.add(key);
  const description = typeof permission.permission === 'string' && permission.permission.trim().length > 0
    ? permission.permission
    : fallbackDescription;
  show(title, {
    id: `permission-${key}`,
    description,
    source: 'permission',
    session: permission.sessionID,
    directory,
    actionRecord: { type: 'open-session', sessionId: permission.sessionID, directory },
    dedupeKey: `permission:${key}`,
    action: {
      label: actionLabel,
      onClick: () => openSession(permission.sessionID, directory),
    },
  });
  return true;
};
