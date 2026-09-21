import crypto from 'crypto';

// Parsing a unified diff into addressable hunks lives here and only here. The
// model anchors its narrative to hunk ids, the client resolves those ids back
// to rendered code, and staleness is "an id the current diff no longer has" —
// all three break the moment two implementations disagree about what an id is,
// so the client is never given the algorithm, only the results.

const FILE_HEADER = /^diff --git /;
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

const shortHash = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);

const parsePathsFromFileHeader = (line) => {
  // `diff --git a/old b/new`, with either side quoted when it contains spaces.
  const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
  if (!match) return null;
  return { oldPath: match[1], newPath: match[2] };
};

const statusFromHeaderLines = (lines) => {
  if (lines.some((line) => line.startsWith('new file mode'))) return 'added';
  if (lines.some((line) => line.startsWith('deleted file mode'))) return 'deleted';
  if (lines.some((line) => line.startsWith('rename from'))) return 'renamed';
  return 'modified';
};

const isBinaryHeader = (lines) => lines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'));

/**
 * Split a unified diff covering any number of files into files and hunks.
 *
 * @param {string} patch raw `git diff` output
 * @param {string} scope opaque namespace for the ids (e.g. 'staged', 'branch').
 *   Two scopes of the same repository can contain byte-identical hunks; the
 *   scope keeps their ids distinct so a walkthrough written against staged
 *   changes never silently resolves against unstaged ones.
 * @returns {{files: Array<{path: string, oldPath: string|null, status: string, binary: boolean, hunks: Array<object>}>}}
 */
export function parseDiffFiles(patch, scope = 'diff') {
  const text = typeof patch === 'string' ? patch : '';
  if (!text.trim()) return { files: [] };

  const lines = text.split(/\r?\n/);
  const files = [];
  let current = null;
  let headerLines = [];
  let hunk = null;

  const closeHunk = () => {
    if (!current || !hunk) return;
    const body = hunk.lines.join('\n');
    // The id covers the header and the body, so any edit to the hunk — even one
    // that keeps its line numbers — produces a different id. That is what makes
    // "this stop is stale" detectable without diffing narratives.
    const digest = shortHash(`${hunk.header}\n${body}`);
    const seen = current.hunkDigests.get(digest) ?? 0;
    current.hunkDigests.set(digest, seen + 1);
    // A file can legitimately contain byte-identical hunks (repeated boilerplate
    // edits). Disambiguate by occurrence so ids stay unique without becoming
    // positional for the common case.
    const suffix = seen === 0 ? '' : `-${seen + 1}`;

    current.hunks.push({
      id: `${scope}:${current.path}:${digest}${suffix}`,
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      added: hunk.added,
      deleted: hunk.deleted,
      patch: `${current.headerText}\n${hunk.header}\n${body}\n`,
      body,
    });
    hunk = null;
  };

  const closeFile = () => {
    closeHunk();
    if (!current) return;
    current.binary = current.binary || isBinaryHeader(headerLines);
    delete current.hunkDigests;
    files.push(current);
    current = null;
  };

  for (const line of lines) {
    if (FILE_HEADER.test(line)) {
      closeFile();
      headerLines = [line];
      const paths = parsePathsFromFileHeader(line);
      current = {
        path: paths?.newPath || paths?.oldPath || '',
        oldPath: paths && paths.oldPath !== paths.newPath ? paths.oldPath : null,
        status: 'modified',
        binary: false,
        headerText: line,
        hunks: [],
        hunkDigests: new Map(),
      };
      continue;
    }

    if (!current) continue;

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      closeHunk();
      current.status = statusFromHeaderLines(headerLines);
      current.headerText = headerLines.join('\n');
      hunk = {
        header: line,
        oldStart: Number.parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10),
        newStart: Number.parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10),
        added: 0,
        deleted: 0,
        lines: [],
      };
      continue;
    }

    if (!hunk) {
      headerLines.push(line);
      continue;
    }

    hunk.lines.push(line);
    if (line.startsWith('+')) hunk.added += 1;
    else if (line.startsWith('-')) hunk.deleted += 1;
  }

  closeFile();

  return {
    files: files.filter((file) => file.path),
  };
}

/**
 * Flatten parsed files into an id-keyed index for resolution and staleness
 * checks.
 */
export function indexHunks(files) {
  const index = new Map();
  for (const file of files) {
    for (const hunk of file.hunks) {
      index.set(hunk.id, { ...hunk, path: file.path, status: file.status });
    }
  }
  return index;
}

/**
 * Every hunk id in the diff, in file-then-position order. Used to compute the
 * "not covered by any stop" tail.
 */
export function listHunkIds(files) {
  const ids = [];
  for (const file of files) {
    for (const hunk of file.hunks) ids.push(hunk.id);
  }
  return ids;
}
