export const MAX_OPEN_FILE_LINES = 5_000;

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
