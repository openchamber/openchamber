const QUESTION_TEXTAREA_LINE_HEIGHT = 20;
const QUESTION_TEXTAREA_MIN_LINES = 2;
const QUESTION_TEXTAREA_MAX_LINES = 10;

export function getQuestionCustomTextareaHeight({
  scrollHeight,
  currentHeight,
}: {
  scrollHeight: number;
  currentHeight: number | null | undefined;
}): number | null {
  const minHeight = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MIN_LINES;
  const maxHeight = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MAX_LINES;
  const nextHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

  return currentHeight === nextHeight ? null : nextHeight;
}
