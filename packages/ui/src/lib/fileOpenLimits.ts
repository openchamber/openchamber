export const MAX_OPEN_FILE_LINES = 20_000;

export const MAX_OPEN_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_OFFICE_PREVIEW_BYTES = 30 * 1024 * 1024;

export const MAX_DATA_PREVIEW_BYTES = 256 * 1024 * 1024;

export const countLinesWithLimit = (content: string, limit: number): number => {
  if (!content) {
    return 1;
  }

  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lines += 1;
      if (lines > limit) {
        return lines;
      }
    }
  }

  return lines;
};
