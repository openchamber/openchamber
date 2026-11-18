import { isNumber, isString } from './inputs.js';

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

const resolvePositiveNumber = (value: number | null | undefined, fallback: number) => {
  if (!isNumber(value) || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const normalizeNotificationPlainText = (text: string) => {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/(^|\W)__(?!\s)(.+?)__(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1$2')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  maxLastMessageLength?: number;
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
  const plainTextMessage = normalizeNotificationPlainText(originalMessage);
  return truncateNotificationText(plainTextMessage, maxLastMessageLength);
};
