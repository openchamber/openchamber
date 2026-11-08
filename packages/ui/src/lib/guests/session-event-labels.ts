import type { GuestSessionEventType } from '@openchamber/sdk';

import type { I18nKey } from '@/lib/i18n';

/** What the approval dialog and the card call each session event an extension subscribed to. */
export const SESSION_EVENT_LABEL_KEYS = {
  'turn-finished': 'settings.extensions.sessionEvent.turn-finished',
  'turn-failed': 'settings.extensions.sessionEvent.turn-failed',
  'permission-asked': 'settings.extensions.sessionEvent.permission-asked',
  'question-asked': 'settings.extensions.sessionEvent.question-asked',
  'turn-started': 'settings.extensions.sessionEvent.turn-started',
  'session-created': 'settings.extensions.sessionEvent.session-created',
  'session-archived': 'settings.extensions.sessionEvent.session-archived',
  'session-deleted': 'settings.extensions.sessionEvent.session-deleted',
} satisfies Record<GuestSessionEventType, I18nKey>;
