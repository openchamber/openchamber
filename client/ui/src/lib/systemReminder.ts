const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

export const wrapSystemReminder = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE)) {
    return trimmed;
  }

  return `${SYSTEM_REMINDER_OPEN}\n${trimmed}\n${SYSTEM_REMINDER_CLOSE}`;
};
