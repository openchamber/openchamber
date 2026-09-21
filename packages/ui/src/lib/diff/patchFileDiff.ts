import {
  parseDiffFromFile,
  parsePatchFiles,
  processFile,
  trimPatchContext,
  type AnnotationSide,
  type FileDiffMetadata,
} from '@pierre/diffs';

const PATCH_DIFF_CACHE_LIMIT = 64;
const DEFAULT_PATCH_CONTEXT_LINES = 3;
const patchFileDiffCache = new Map<string, FileDiffMetadata>();

export const isBinaryPatch = (patch: string): boolean =>
  /^Binary files .+ differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

const patchVersionHeader = (patch: string): string | null => {
  const firstHunk = patch.search(/^@@\s/m);
  if (firstHunk < 0) return null;
  const header = patch.slice(0, firstHunk);
  // getDiff requests full object IDs. Do not infer identity from abbreviated
  // hashes or from changed-line totals, which survive partial staging.
  return /^index (?:[a-f0-9]{40}|[a-f0-9]{64})\.\.(?:[a-f0-9]{40}|[a-f0-9]{64})(?: [0-7]+)?$/m.test(header)
    ? header : null;
};

export const haveMatchingPatchVersions = (displayPatch: string, actionPatch: string): boolean => {
  const displayHeader = patchVersionHeader(displayPatch);
  return displayHeader !== null && displayHeader === patchVersionHeader(actionPatch);
};

export const fileDiffFromPatch = (
  file: string,
  patch: string,
  contextLines = DEFAULT_PATCH_CONTEXT_LINES
): FileDiffMetadata => {
  const key = `${file}\0${contextLines}\0${patch}`;
  const cached = patchFileDiffCache.get(key);
  if (cached) {
    patchFileDiffCache.delete(key);
    patchFileDiffCache.set(key, cached);
    return cached;
  }

  const completeContents = completePatchContents(patch);
  const value = completeContents
    ? (processFile(trimPatchContext(patch, contextLines), {
      oldFile: { name: file, contents: completeContents.before },
      newFile: { name: file, contents: completeContents.after },
    }) ?? emptyFileDiff(file))
    : (parsePatchFiles(withPatchHeader(file, patch))[0]?.files[0] ?? emptyFileDiff(file));
  patchFileDiffCache.set(key, value);

  while (patchFileDiffCache.size > PATCH_DIFF_CACHE_LIMIT) {
    const firstKey = patchFileDiffCache.keys().next().value;
    if (!firstKey) break;
    patchFileDiffCache.delete(firstKey);
  }

  return value;
};

const withPatchHeader = (file: string, patch: string): string => {
  if (!patch.trim()) {
    return patch;
  }

  if (patch.startsWith('diff --git ') || /^--- [^\n]*\r?\n\+\+\+ /m.test(patch)) {
    return patch;
  }

  return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`;
};

const completePatchContents = (patch: string): { before: string; after: string } | undefined => {
  if (!patch.startsWith('diff --git ') && !/^--- [^\n]*\t?\r?\n\+\+\+ [^\n]*\t?(?:\r?\n|$)/m.test(patch)) {
    return undefined;
  }

  const hunkMatches = [...patch.matchAll(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@[^\n]*(?:\r?\n|$)/gm)];
  if (hunkMatches.length !== 1) {
    return undefined;
  }

  const hunk = hunkMatches[0];
  const oldStart = Number.parseInt(hunk[1] ?? '', 10);
  const newStart = Number.parseInt(hunk[2] ?? '', 10);
  if (oldStart > 1 || newStart > 1 || !Number.isFinite(oldStart) || !Number.isFinite(newStart)) {
    return undefined;
  }

  const hunkStart = (hunk.index ?? 0) + hunk[0].length;
  const body = patch.slice(hunkStart);
  const before: Array<{ text: string; newline: boolean }> = [];
  const after: Array<{ text: string; newline: boolean }> = [];
  let previous: '-' | '+' | ' ' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ') || rawLine.startsWith('@@ ')) {
      break;
    }

    if (rawLine.startsWith('\\')) {
      if (previous === '-' || previous === ' ') {
        const value = before.at(-1);
        if (value) value.newline = false;
      }
      if (previous === '+' || previous === ' ') {
        const value = after.at(-1);
        if (value) value.newline = false;
      }
      continue;
    }

    if (rawLine.startsWith('-')) {
      before.push({ text: rawLine.slice(1), newline: true });
      previous = '-';
      continue;
    }

    if (rawLine.startsWith('+')) {
      after.push({ text: rawLine.slice(1), newline: true });
      previous = '+';
      continue;
    }

    if (!rawLine.startsWith(' ')) {
      continue;
    }

    before.push({ text: rawLine.slice(1), newline: true });
    after.push({ text: rawLine.slice(1), newline: true });
    previous = ' ';
  }

  return {
    before: joinPatchLines(before),
    after: joinPatchLines(after),
  };
};

const joinPatchLines = (lines: Array<{ text: string; newline: boolean }>): string =>
  lines.map((line) => line.text + (line.newline ? '\n' : '')).join('');

const emptyFileDiff = (file: string): FileDiffMetadata =>
  parseDiffFromFile({ name: file, contents: '' }, { name: file, contents: '' });

/**
 * Split a unified diff patch for a single file into standalone per-hunk patches.
 *
 * Each returned patch preserves the original file header (everything before the
 * first `@@` hunk header) plus exactly one hunk, producing a patch that can be
 * fed to `git apply` on its own.
 *
 * Returns an empty array when no hunk headers are present.
 */
export const splitPatchIntoHunks = (patch: string): string[] => {
  if (!patch) return [];

  // Git's structural newlines are LF. A CR before LF inside a hunk belongs
  // to the file contents and must survive an apply/reverse round trip.
  const starts = [...patch.matchAll(/^@@\s/gm)].map((match) => match.index);
  if (starts.length === 0) return [];
  const header = patch.slice(0, starts[0]);
  return starts.map((start, index) => {
    const hunk = header + patch.slice(start, starts[index + 1] ?? patch.length);
    return hunk.endsWith('\n') ? hunk : `${hunk}\n`;
  });
};

/**
 * Extract a standalone patch for a single hunk by zero-based index.
 *
 * Returns `null` when the index is out of range or the patch has no hunks.
 */
export const extractHunkPatch = (patch: string, hunkIndex: number): string | null => {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null;
  const hunks = splitPatchIntoHunks(patch);
  return hunks[hunkIndex] ?? null;
};

export interface PatchHunkAnchor {
  index: number;
  side: AnnotationSide;
  lineNumber: number;
}

/** Anchor each action after the final changed row, before trailing context. */
export const getPatchHunkAnchors = (patch: string): PatchHunkAnchor[] => {
  const anchors: PatchHunkAnchor[] = [];
  for (const [index, hunk] of splitPatchIntoHunks(patch).entries()) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*(?:\n|$)/m.exec(hunk);
    if (!header) continue;
    let deletionLine = Number(header[1]);
    let additionLine = Number(header[3]);
    let anchor: PatchHunkAnchor | undefined;
    for (const line of hunk.slice(header.index + header[0].length).split('\n')) {
      if (line.startsWith('-')) {
        anchor = { index, side: 'deletions', lineNumber: deletionLine++ };
      } else if (line.startsWith('+')) {
        anchor = { index, side: 'additions', lineNumber: additionLine++ };
      } else if (line.startsWith(' ')) {
        deletionLine += 1;
        additionLine += 1;
      }
    }
    if (anchor && Number.isSafeInteger(anchor.lineNumber) && anchor.lineNumber > 0) {
      anchors.push(anchor);
    }
  }
  return anchors;
};
