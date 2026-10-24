const FORM_TEXTAREA_LINE_HEIGHT = 20;
const FORM_TEXTAREA_MIN_LINES = 2;
const FORM_TEXTAREA_MAX_LINES = 10;

export const FORM_CUSTOM_TEXTAREA_MIN_HEIGHT = FORM_TEXTAREA_LINE_HEIGHT * FORM_TEXTAREA_MIN_LINES;

export function getFormCustomTextareaHeight(contentHeight: number): number {
  const maxHeight = FORM_TEXTAREA_LINE_HEIGHT * FORM_TEXTAREA_MAX_LINES;
  return Math.min(Math.max(contentHeight, FORM_CUSTOM_TEXTAREA_MIN_HEIGHT), maxHeight);
}
