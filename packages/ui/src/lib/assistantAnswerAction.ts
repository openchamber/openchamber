export type AssistantAnswerAction = 'start-from-answer' | 'fork-session';

export const DEFAULT_ASSISTANT_ANSWER_ACTION: AssistantAnswerAction = 'start-from-answer';

export const normalizeAssistantAnswerAction = (value: string | null | undefined): AssistantAnswerAction => (
  value === 'fork-session' ? 'fork-session' : DEFAULT_ASSISTANT_ANSWER_ACTION
);
