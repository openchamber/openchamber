// An error longer than this starts collapsed. Provider failures can carry a
// whole response body or a JSON parse dump of hundreds of thousands of
// characters; shown in full, one such error buries the rest of the chat.
const COLLAPSE_AFTER_CHARS = 1_000;
const PREVIEW_MAX_CHARS = 400;
const PREVIEW_MAX_LINES = 6;

/**
 * The start of an error long enough to collapse, or null when the error is
 * short enough to show in full.
 */
export const getLongErrorPreview = (text: string): string | null => {
  if (text.length <= COLLAPSE_AFTER_CHARS) return null;
  let end = PREVIEW_MAX_CHARS;
  // Do not split a surrogate pair (emoji, rare CJK) in half.
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  const preview = text.slice(0, end).split('\n').slice(0, PREVIEW_MAX_LINES).join('\n');
  return `${preview.trimEnd()}…`;
};
