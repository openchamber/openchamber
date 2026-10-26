export const getFirstChangedModifiedLineFromPatch = (patch: string): number | null => {
  if (!patch) {
    return null;
  }

  const lines = patch.split('\n');
  let modifiedLine: number | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (hunkMatch) {
      const parsed = Number.parseInt(hunkMatch[1] ?? '', 10);
      modifiedLine = Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
      continue;
    }

    if (modifiedLine === null) {
      continue;
    }

    if (line.startsWith(' ')) {
      modifiedLine += 1;
      continue;
    }

    if (line.startsWith('+')) {
      return modifiedLine;
    }

    if (line.startsWith('-')) {
      return Math.max(1, modifiedLine);
    }
  }

  return null;
};
