const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;
const DEFAULT_NOTIFICATION_SUMMARY_THRESHOLD = 200;
const DEFAULT_NOTIFICATION_SUMMARY_LENGTH = 100;

const resolvePositiveNumber = (value, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
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

export const prepareNotificationLastMessage = async ({ message, settings, summarize }) => {
  const originalMessage = typeof message === 'string' ? message : '';
  if (!originalMessage) {
    return '';
  }

  const shouldSummarize = settings?.summarizeLastMessage === true && typeof summarize === 'function';
  const summaryThreshold = resolvePositiveNumber(settings?.summaryThreshold, DEFAULT_NOTIFICATION_SUMMARY_THRESHOLD);
  const summaryLength = resolvePositiveNumber(settings?.summaryLength, DEFAULT_NOTIFICATION_SUMMARY_LENGTH);
  const maxLastMessageLength = resolvePositiveNumber(settings?.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);

  let messageForNotification = originalMessage;
  if (shouldSummarize && originalMessage.length > summaryThreshold) {
    try {
      const summary = await summarize(originalMessage, summaryLength);
      if (typeof summary === 'string' && summary.trim().length > 0) {
        messageForNotification = summary;
      }
    } catch {
      messageForNotification = originalMessage;
    }
  }

  return truncateNotificationText(messageForNotification, maxLastMessageLength);
};
