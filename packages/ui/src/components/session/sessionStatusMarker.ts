import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

import type { I18nKey } from '@/lib/i18n';

type SessionStatusMarkerInput = {
  statusType: SessionStatus['type'] | null | undefined;
  pendingPermissionCount: number;
  pendingQuestionCount: number;
  showUnread: boolean;
  hasUnseenError: boolean;
};

type SessionStatusMarker = {
  className: string;
  labelKey: I18nKey;
};

export function getSessionStatusMarker(input: SessionStatusMarkerInput): SessionStatusMarker | null {
  const isStreaming = input.statusType === 'busy' || input.statusType === 'retry';

  if (input.pendingPermissionCount > 0) {
    return {
      className: 'bg-status-warning',
      labelKey: 'sessions.sidebar.session.status.permissionRequired',
    };
  }

  if (input.pendingQuestionCount > 0) {
    return {
      className: 'bg-status-warning',
      labelKey: 'chat.toolPart.awaitingResponse',
    };
  }

  if (isStreaming) {
    return {
      className: 'bg-status-info animate-busy-pulse',
      labelKey: 'sessions.sidebar.session.status.active',
    };
  }

  if (!input.showUnread) {
    return null;
  }

  if (input.hasUnseenError) {
    return {
      className: 'bg-status-error',
      labelKey: 'sessions.sidebar.session.status.unreadError',
    };
  }

  return {
    className: 'bg-status-success',
    labelKey: 'sessions.sidebar.session.status.unread',
  };
}
