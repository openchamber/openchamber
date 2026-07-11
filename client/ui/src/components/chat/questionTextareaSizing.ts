const QUESTION_TEXTAREA_LINE_HEIGHT = 20;
const QUESTION_TEXTAREA_MIN_LINES = 2;
const QUESTION_TEXTAREA_MAX_LINES = 10;

export const QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MIN_LINES;

export function getQuestionCustomTextareaHeight({
  scrollHeight,
  currentHeight,
}: {
  scrollHeight: number;
  currentHeight: number | null | undefined;
}): number | null {
  const maxHeight = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MAX_LINES;
  const nextHeight = Math.min(Math.max(scrollHeight, QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT), maxHeight);

  return currentHeight === nextHeight ? null : nextHeight;
}
