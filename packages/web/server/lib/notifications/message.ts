import { isNumber, isString } from './inputs.js';
import type { JsonValue } from './contracts.js';
import { NOTIFICATION_SOURCE_CHARS, notificationPlainText } from './plainText.js';

const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;

interface GenericNotificationTitles {
  [kind: string]: string | undefined;
}

const GENERIC_NOTIFICATION_TITLES: GenericNotificationTitles = {
  ready: 'Agent response is ready',
  error: 'Agent hit an error',
  question: 'Agent needs your input',
  permission: 'Agent needs permission',
  goal_complete: 'Goal complete',
  goal_blocked: 'Goal blocked',
  goal_budget: 'Goal reached its token budget',
  review: 'Review finished',
  'pull-request': 'Pull request update',
  'share-answer': 'A shared page was answered',
};

export const genericNotificationTitle = (kind: string) => GENERIC_NOTIFICATION_TITLES[kind] || 'Agent update';

const resolvePositiveNumber = (value: JsonValue | undefined, fallback: number) => {
  if (!isNumber(value) || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

export const truncateNotificationText = (text: string | null | undefined, maxLength = DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH) => {
  if (!isString(text)) {
    return '';
  }

  const safeMaxLength = resolvePositiveNumber(maxLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  if (text.length <= safeMaxLength) {
    return text;
  }

  return `${text.slice(0, safeMaxLength)}...`;
};

export interface NotificationMessageSettings {
  maxLastMessageLength?: JsonValue;
}

export const prepareNotificationLastMessage = async ({ message, settings }: {
  message: string | null | undefined;
  settings: NotificationMessageSettings | null | undefined;
}) => {
  const originalMessage = isString(message) ? message : '';
  if (!originalMessage) {
    return '';
  }

  const maxLastMessageLength = resolvePositiveNumber(settings?.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  const plainTextMessage = notificationPlainText(originalMessage.slice(0, NOTIFICATION_SOURCE_CHARS));
  return truncateNotificationText(plainTextMessage, maxLastMessageLength);
};
