// Rebuilds the pre-edit file for the VS Code diff view from the current file
// and the unified diff OpenCode stored for an edit tool call.
//
// OpenCode v2 strips the indentation shared by every changed and context line
// before storing an edit diff (trimDiff in upstream core/tool/plugin/patch.ts).
// Pasting those trimmed old lines back into the real, indented file would show
// the "before" side without indentation, so the stripped prefix is recovered
// from the real file and re-added.

type ParsedDiffHunk = {
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

const parseUnifiedDiffHunks = (patch: string): ParsedDiffHunk[] => {
  const lines = patch.split(/\r?\n/);
  const hunks: ParsedDiffHunk[] = [];

  let current: ParsedDiffHunk | null = null;

  for (const line of lines) {
    const headerMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }
      current = {
        newStart: Number(headerMatch[1] || 1),
        oldLines: [],
        newLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) {
      continue;
    }

    if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(' ')) {
      const content = line.slice(1);
      current.oldLines.push(content);
      current.newLines.push(content);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
};

const isBlank = (line: string): boolean => line.trim().length === 0;

// Returns the whitespace prefix OpenCode stripped from every line of the
// patch, '' when the patch already matches the file, or null when the new
// lines cannot be aligned with the file under one consistent prefix.
const detectStrippedIndent = (fileLines: string[], hunks: ParsedDiffHunk[]): string | null => {
  let prefix: string | null = null;
  for (const hunk of hunks) {
    const startIndex = Math.max(0, hunk.newStart - 1);
    for (let offset = 0; offset < hunk.newLines.length; offset += 1) {
      const patchLine = hunk.newLines[offset] ?? '';
      if (isBlank(patchLine)) continue;
      const fileLine = fileLines[startIndex + offset];
      if (fileLine === undefined || !fileLine.endsWith(patchLine)) return null;
      const candidate = fileLine.slice(0, fileLine.length - patchLine.length);
      if (!isBlank(candidate)) return null;
      if (prefix === null) {
        prefix = candidate;
      } else if (candidate.length !== prefix.length) {
        return null;
      }
    }
  }
  return prefix ?? '';
};

export const reconstructOriginalContentFromPatch = (modifiedContent: string, patch: string): string | null => {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) {
    return null;
  }

  const lines = modifiedContent.split('\n');
  // Unaligned patches keep the old behavior: paste old lines as stored.
  const prefix = detectStrippedIndent(lines.map((line) => line.replace(/\r$/, '')), hunks) ?? '';
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    if (!hunk) {
      continue;
    }
    const startIndex = Math.max(0, hunk.newStart - 1);
    const replaceCount = hunk.newLines.length;
    const oldLines = prefix
      ? hunk.oldLines.map((line) => (isBlank(line) ? line : prefix + line))
      : hunk.oldLines;
    lines.splice(startIndex, replaceCount, ...oldLines);
  }

  return lines.join('\n');
};
