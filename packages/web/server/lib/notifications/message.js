const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;

const GENERIC_NOTIFICATION_TITLES = {
  ready: 'Agent response is ready',
  error: 'Agent hit an error',
  question: 'Agent needs your input',
  permission: 'Agent needs permission',
  goal_complete: 'Goal complete',
  goal_blocked: 'Goal blocked',
  goal_budget: 'Goal reached its token budget',
  review: 'Review finished',
};

export const genericNotificationTitle = (kind) => GENERIC_NOTIFICATION_TITLES[kind] || 'Agent update';

const resolvePositiveNumber = (value, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const normalizeNotificationPlainText = (text) => {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Underscore and single-star emphasis only at word edges, so `user_id`,
    // `snake_case` and `2 * 3` survive.
    .replace(/(^|\W)__(?!\s)(.+?)__(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1$2')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const truncateNotificationText = (text, maxLength = DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH) => {
  if (typeof text !== 'string') {
    return '';
  }

  const safeMaxLength = resolvePositiveNumber(maxLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  if (text.length <= safeMaxLength) {
    return text;
  }

  return `${text.slice(0, safeMaxLength)}...`;
};

export const prepareNotificationLastMessage = async ({ message, settings }) => {
  const originalMessage = typeof message === 'string' ? message : '';
  if (!originalMessage) {
    return '';
  }

  const maxLastMessageLength = resolvePositiveNumber(settings?.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  const plainTextMessage = normalizeNotificationPlainText(originalMessage);
  return truncateNotificationText(plainTextMessage, maxLastMessageLength);
};
