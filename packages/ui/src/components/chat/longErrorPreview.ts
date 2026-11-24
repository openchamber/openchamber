const COLLAPSE_AFTER_CHARS = 1_000;
const PREVIEW_MAX_CHARS = 400;
const PREVIEW_MAX_LINES = 6;

export const getLongErrorPreview = (text: string): string | null => {
  if (text.length <= COLLAPSE_AFTER_CHARS) return null;
  let end = PREVIEW_MAX_CHARS;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  const preview = text.slice(0, end).split('\n').slice(0, PREVIEW_MAX_LINES).join('\n');
  return `${preview.trimEnd()}…`;
};
