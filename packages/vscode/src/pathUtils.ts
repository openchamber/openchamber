export const normalizeWindowsDriveLetter = (p: string): string =>
  p.replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');

export const pathsEqualWithNormalizedDriveLetter = (left: string, right: string): boolean =>
  normalizeWindowsDriveLetter(left) === normalizeWindowsDriveLetter(right);
