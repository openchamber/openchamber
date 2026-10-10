import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from '@pierre/diffs';

// Context kept around each remaining change, matching the patches git returns.
const CONTEXT_LINES = 3;
// Above this many line pairs a change block is left as it is: matching it
// would cost more memory than hiding its whitespace is worth.
const MAX_ALIGNMENT_CELLS = 1_000_000;

type HunkBlock = ContextContent | ChangeContent;

const filteredDiffs = new WeakMap<FileDiffMetadata, FileDiffMetadata>();

/**
 * The same diff with whitespace-only line changes turned into context, as
 * `git diff -w` would show it. Each side keeps its own text, line numbers do
 * not move, and hunks are recut around the changes that remain, so a hunk
 * that only re-indented code disappears. Returns the input object when no
 * line changed by whitespace alone.
 */
export const hideWhitespaceChanges = (fileDiff: FileDiffMetadata): FileDiffMetadata => {
  const cached = filteredDiffs.get(fileDiff);
  if (cached) return cached;

  let hidden = false;
  const hunks: Hunk[] = [];
  for (const hunk of fileDiff.hunks) {
    const blocks: HunkBlock[] = [];
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        pushBlock(blocks, { ...content });
        continue;
      }
      const refined = refineChange(fileDiff, content);
      if (refined.length > 1 || refined[0]?.type === 'context') hidden = true;
      for (const block of refined) pushBlock(blocks, block);
    }
    hunks.push(...recutHunk(hunk, blocks));
  }

  const result = hidden ? withHunks(fileDiff, hunks) : fileDiff;
  filteredDiffs.set(fileDiff, result);
  return result;
};

const normalize = (line: string): string => line.replace(/\s+/g, '');

/** Splits one change block at the line pairs that differ only by whitespace. */
const refineChange = (fileDiff: FileDiffMetadata, change: ChangeContent): HunkBlock[] => {
  if (change.deletions === 0 || change.additions === 0) return [{ ...change }];

  const deleted = fileDiff.deletionLines.slice(change.deletionLineIndex, change.deletionLineIndex + change.deletions);
  const added = fileDiff.additionLines.slice(change.additionLineIndex, change.additionLineIndex + change.additions);
  const blocks: HunkBlock[] = [];
  let deletion = 0;
  let addition = 0;
  for (const [matchedDeletion, matchedAddition] of alignIgnoringWhitespace(deleted, added)) {
    if (matchedDeletion > deletion || matchedAddition > addition) {
      blocks.push({
        type: 'change',
        deletions: matchedDeletion - deletion,
        deletionLineIndex: change.deletionLineIndex + deletion,
        additions: matchedAddition - addition,
        additionLineIndex: change.additionLineIndex + addition,
      });
    }
    pushBlock(blocks, {
      type: 'context',
      lines: 1,
      deletionLineIndex: change.deletionLineIndex + matchedDeletion,
      additionLineIndex: change.additionLineIndex + matchedAddition,
    });
    deletion = matchedDeletion + 1;
    addition = matchedAddition + 1;
  }
  if (deletion < change.deletions || addition < change.additions) {
    blocks.push({
      type: 'change',
      deletions: change.deletions - deletion,
      deletionLineIndex: change.deletionLineIndex + deletion,
      additions: change.additions - addition,
      additionLineIndex: change.additionLineIndex + addition,
    });
  }
  return blocks;
};

/** Index pairs of the longest run of lines equal once whitespace is removed. */
const alignIgnoringWhitespace = (deleted: string[], added: string[]): Array<[number, number]> => {
  const a = deleted.map(normalize);
  const b = added.map(normalize);
  const pairs: Array<[number, number]> = [];

  // Re-indented code matches line for line, so most blocks end here.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    pairs.push([prefix, prefix]);
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows = a.length - prefix - suffix;
  const columns = b.length - prefix - suffix;
  if (rows > 0 && columns > 0 && (rows + 1) * (columns + 1) <= MAX_ALIGNMENT_CELLS) {
    // lengths[i][j]: longest common run of a[prefix + i..] and b[prefix + j..].
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = a[prefix + i] === b[prefix + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[prefix + i] === b[prefix + j]) {
        pairs.push([prefix + i, prefix + j]);
        i += 1;
        j += 1;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  for (let k = suffix; k > 0; k -= 1) {
    pairs.push([a.length - k, b.length - k]);
  }
  return pairs;
};

const pushBlock = (blocks: HunkBlock[], block: HunkBlock): void => {
  const previous = blocks.at(-1);
  if (previous?.type === 'context' && block.type === 'context') {
    previous.lines += block.lines;
    return;
  }
  blocks.push(block);
};

const sliceContext = (context: ContextContent, from: number, lines: number): ContextContent => ({
  type: 'context',
  lines,
  deletionLineIndex: context.deletionLineIndex + from,
  additionLineIndex: context.additionLineIndex + from,
});

/**
 * Cuts a hunk's blocks into hunks with at most CONTEXT_LINES of context around
 * each change, never reaching past the original hunk: a patch has no lines
 * beyond it. A hunk without changes yields nothing.
 */
const recutHunk = (hunk: Hunk, blocks: HunkBlock[]): Hunk[] => {
  const pieces: HunkBlock[][] = [];
  let current: HunkBlock[] | null = null;
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'change') {
      if (!current) {
        current = [];
        const previous = blocks[index - 1];
        if (previous?.type === 'context') {
          const lines = Math.min(previous.lines, CONTEXT_LINES);
          current.push(sliceContext(previous, previous.lines - lines, lines));
        }
      }
      current.push(block);
      continue;
    }
    if (!current) continue;
    const followedByChange = index < blocks.length - 1;
    if (followedByChange && block.lines <= CONTEXT_LINES * 2) {
      current.push(block);
      continue;
    }
    current.push(sliceContext(block, 0, Math.min(block.lines, CONTEXT_LINES)));
    pieces.push(current);
    current = null;
  }
  if (current) pieces.push(current);

  const hunkEnd = blocks.at(-1);
  return pieces.map((piece) => {
    const pieceEnd = piece.at(-1);
    const endsSourceHunk = pieceEnd !== undefined && hunkEnd !== undefined
      && blockEnd(pieceEnd, 'deletion') === blockEnd(hunkEnd, 'deletion')
      && blockEnd(pieceEnd, 'addition') === blockEnd(hunkEnd, 'addition');
    return buildHunk(hunk, piece, endsSourceHunk);
  });
};

const blockEnd = (block: HunkBlock, side: 'deletion' | 'addition'): number => {
  if (side === 'deletion') return block.deletionLineIndex + (block.type === 'context' ? block.lines : block.deletions);
  return block.additionLineIndex + (block.type === 'context' ? block.lines : block.additions);
};

const buildHunk = (source: Hunk, blocks: HunkBlock[], endsSourceHunk: boolean): Hunk => {
  let additionLines = 0;
  let deletionLines = 0;
  let contextLines = 0;
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  for (const block of blocks) {
    if (block.type === 'context') {
      contextLines += block.lines;
      splitLineCount += block.lines;
      unifiedLineCount += block.lines;
    } else {
      additionLines += block.additions;
      deletionLines += block.deletions;
      splitLineCount += Math.max(block.additions, block.deletions);
      unifiedLineCount += block.additions + block.deletions;
    }
  }

  const first = blocks[0];
  const additionCount = contextLines + additionLines;
  const deletionCount = contextLines + deletionLines;
  const additionStart = sideStart(
    sideStartBoundary(source.additionStart, source.additionCount) + first.additionLineIndex - source.additionLineIndex,
    additionCount,
  );
  const deletionStart = sideStart(
    sideStartBoundary(source.deletionStart, source.deletionCount) + first.deletionLineIndex - source.deletionLineIndex,
    deletionCount,
  );
  const isSourceStart = first.additionLineIndex === source.additionLineIndex && first.deletionLineIndex === source.deletionLineIndex;
  const hunkContext = isSourceStart ? source.hunkContext : undefined;

  return {
    collapsedBefore: 0,
    additionStart,
    additionCount,
    additionLines,
    additionLineIndex: first.additionLineIndex,
    deletionStart,
    deletionCount,
    deletionLines,
    deletionLineIndex: first.deletionLineIndex,
    hunkContent: blocks,
    hunkContext,
    hunkSpecs: `@@ -${deletionStart},${deletionCount} +${additionStart},${additionCount} @@${hunkContext ? ` ${hunkContext}` : ''}\n`,
    splitLineStart: 0,
    splitLineCount,
    unifiedLineStart: 0,
    unifiedLineCount,
    noEOFCRDeletions: endsSourceHunk && source.noEOFCRDeletions,
    noEOFCRAdditions: endsSourceHunk && source.noEOFCRAdditions,
  };
};

// A hunk side's start counts the lines before it, plus one unless the side is
// empty: `-5,0` inserts after line 5, `-6,2` starts at line 6.
const sideStartBoundary = (start: number, count: number): number => start - (count === 0 ? 0 : 1);
const sideStart = (boundary: number, count: number): number => boundary + (count === 0 ? 0 : 1);

/** Places the hunks the way the patch parser does: gaps, row offsets, totals. */
const withHunks = (fileDiff: FileDiffMetadata, hunks: Hunk[]): FileDiffMetadata => {
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let lastHunkEnd = 0;
  for (const hunk of hunks) {
    hunk.collapsedBefore = Math.max(sideStartBoundary(hunk.additionStart, hunk.additionCount) - lastHunkEnd, 0);
    hunk.splitLineStart = splitLineCount + hunk.collapsedBefore;
    hunk.unifiedLineStart = unifiedLineCount + hunk.collapsedBefore;
    splitLineCount += hunk.collapsedBefore + hunk.splitLineCount;
    unifiedLineCount += hunk.collapsedBefore + hunk.unifiedLineCount;
    lastHunkEnd = sideStartBoundary(hunk.additionStart, hunk.additionCount) + hunk.additionCount;
  }
  const lastHunk = hunks.at(-1);
  if (lastHunk && !fileDiff.isPartial && fileDiff.additionLines.length > 0 && fileDiff.deletionLines.length > 0) {
    const collapsedAfter = Math.max(fileDiff.additionLines.length - lastHunkEnd, 0);
    splitLineCount += collapsedAfter;
    unifiedLineCount += collapsedAfter;
  }

  return {
    ...fileDiff,
    ...(fileDiff.isPartial ? compactPartialLines(fileDiff, hunks) : { hunks }),
    splitLineCount,
    unifiedLineCount,
    cacheKey: fileDiff.cacheKey === undefined ? undefined : `${fileDiff.cacheKey}:hide-whitespace`,
  };
};

/**
 * A patch diff holds only the lines its hunks show, in hunk order, and the
 * renderer rebuilds each side by joining its hunks' lines. A hunk dropped or
 * trimmed here would shift every later line and leave the last ones missing,
 * so the kept lines are copied out and the blocks point at their new places.
 */
const compactPartialLines = (
  fileDiff: FileDiffMetadata,
  hunks: Hunk[],
): Pick<FileDiffMetadata, 'hunks' | 'deletionLines' | 'additionLines'> => {
  const deletionLines: string[] = [];
  const additionLines: string[] = [];
  const copy = (from: string[], to: string[], start: number, count: number) => {
    for (let index = start; index < start + count; index += 1) to.push(from[index]);
  };
  const compacted = hunks.map((hunk): Hunk => {
    const deletionLineIndex = deletionLines.length;
    const additionLineIndex = additionLines.length;
    const hunkContent = hunk.hunkContent.map((block): HunkBlock => {
      const moved = { ...block, deletionLineIndex: deletionLines.length, additionLineIndex: additionLines.length };
      copy(fileDiff.deletionLines, deletionLines, block.deletionLineIndex, block.type === 'context' ? block.lines : block.deletions);
      copy(fileDiff.additionLines, additionLines, block.additionLineIndex, block.type === 'context' ? block.lines : block.additions);
      return moved;
    });
    return { ...hunk, deletionLineIndex, additionLineIndex, hunkContent };
  });
  return { hunks: compacted, deletionLines, additionLines };
};
