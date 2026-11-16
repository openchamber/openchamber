const LEGACY_DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{last_message}' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: '{agent_name} needs input', message: '{last_message}' },
  subtask: { title: 'Subtask complete', message: '{last_message}' },
} as const;

export const EMPTY_NOTIFICATION_TEMPLATES = {
  completion: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  subtask: { title: '', message: '' },
} as const;

const isSameTemplateValue = (
  a: { title: string; message: string } | undefined,
  b: { title: string; message: string }
) => {
  if (!a) return false;
  return a.title === b.title && a.message === b.message;
};

export const isLegacyDefaultTemplates = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, { title: string; message: string } | undefined>;
  return (
    isSameTemplateValue(candidate.completion, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.completion)
    && isSameTemplateValue(candidate.error, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.error)
    && isSameTemplateValue(candidate.question, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.question)
    && isSameTemplateValue(candidate.subtask, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.subtask)
  );
};
