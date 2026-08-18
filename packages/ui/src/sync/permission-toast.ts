import type { PermissionRequest } from '@/types/permission';

type PermissionToastOptions = {
  permission: PermissionRequest;
  directory: string;
  isViewed: boolean;
  pendingIds: Set<string>;
  show: (title: string, options: {
    id: string;
    description: string;
    action: { label: string; onClick: () => void };
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
  show,
  openSession,
}: PermissionToastOptions): boolean => {
  const key = getPermissionToastKey(permission.sessionID, permission.id);
  if (isViewed || !key || pendingIds.has(key)) return false;

  pendingIds.add(key);
  const description = typeof permission.permission === 'string' && permission.permission.trim().length > 0
    ? permission.permission
    : 'Agent needs your approval';
  show('Permission needed', {
    id: `permission-${key}`,
    description,
    action: {
      label: 'Open session',
      onClick: () => openSession(permission.sessionID, directory),
    },
  });
  return true;
};
