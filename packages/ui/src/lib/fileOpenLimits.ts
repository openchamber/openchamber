export const MAX_OPEN_FILE_LINES = 20_000;

/**
 * Past this size a file is not read to open it: the whole file would travel
 * as one string, and a 100 MB file froze the app.
 */
export const MAX_OPEN_FILE_BYTES = 10 * 1024 * 1024;

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
