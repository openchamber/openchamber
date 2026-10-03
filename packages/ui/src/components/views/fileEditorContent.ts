export const LARGE_FILE_CHAR_THRESHOLD = 200_000;
export type FileLineEnding = '\n' | '\r\n';

const detectLineEnding = (content: string): FileLineEnding => {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue;
    if (index > 0 && content.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
};

const normalizeLineEndings = (content: string) => content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** A draft is always complete, even when its initial presentation is a preview. */
export const prepareFileEditorContent = (content: string) => ({
  content: normalizeLineEndings(content),
  lineEnding: detectLineEnding(content),
});

export const serializeEditorContent = (content: string, lineEnding: FileLineEnding): string => {
  const normalized = normalizeLineEndings(content);
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
};

export const initialFileTextMode = (content: string, preferred?: 'view' | 'edit'): 'view' | 'edit' => (
  preferred ?? (content.length > LARGE_FILE_CHAR_THRESHOLD ? 'view' : 'edit')
);

/** Include the whole text so same-length edits in the middle invalidate previews. */
export const makeFileContentCacheKey = (content: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `${content.length}:${hash.toString(16)}`;
};
