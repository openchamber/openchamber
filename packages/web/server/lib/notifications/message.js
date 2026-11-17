const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;

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

  // The cut must not split a surrogate pair: a cut landing on a high
  // surrogate backs off to the pair boundary so the preview never ends in
  // a lone surrogate (which encodes as U+FFFD in the push payload).
  let end = safeMaxLength;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}...`;
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
