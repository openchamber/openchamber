export type ReadyHighlight = { code: string; language: string; lines: string[] };

const NO_CARRIED_LINES: readonly (string | undefined)[] = [];

export const carryUnchangedLines = (
  previous: ReadyHighlight | null,
  code: string,
  language: string,
): readonly (string | undefined)[] => {
  if (!previous || previous.language !== language) return NO_CARRIED_LINES;
  const before = previous.code.split('\n');
  return code.split('\n').map((line, index) => (before[index] === line ? previous.lines[index] : undefined));
};
