import crypto from 'crypto';

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  deleted: number;
  patch: string;
  body: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  binary: boolean;
  headerText: string;
  hunks: DiffHunk[];
}

interface PendingHunk extends Omit<DiffHunk, 'id' | 'patch' | 'body'> {
  lines: string[];
}

const isPatchText = (value: unknown): value is string => typeof value === 'string';

const FILE_HEADER = /^diff --git /;
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

const shortHash = (value: string) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);

const parsePathsFromFileHeader = (line: string) => {
  const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
  if (!match) return null;
  return { oldPath: match[1] ?? '', newPath: match[2] ?? '' };
};

const statusFromHeaderLines = (lines: string[]): DiffFile['status'] => {
  if (lines.some((line) => line.startsWith('new file mode'))) return 'added';
  if (lines.some((line) => line.startsWith('deleted file mode'))) return 'deleted';
  if (lines.some((line) => line.startsWith('rename from'))) return 'renamed';
  return 'modified';
};

const isBinaryHeader = (lines: string[]) => lines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'));

export function parseDiffFiles(patch: string | undefined, scope = 'diff') {
  const text = isPatchText(patch) ? patch : '';
  if (!text.trim()) return { files: [] };

  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let current: (DiffFile & { hunkDigests: Map<string, number> }) | null = null;
  let headerLines: string[] = [];
  let hunk: PendingHunk | null = null;

  const closeHunk = () => {
    if (!current || !hunk) return;
    const body = hunk.lines.join('\n');
    const digest = shortHash(`${hunk.header}\n${body}`);
    const seen = current.hunkDigests.get(digest) ?? 0;
    current.hunkDigests.set(digest, seen + 1);
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
    const { hunkDigests: _hunkDigests, ...file } = current;
    files.push(file);
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
        oldStart: Number.parseInt(hunkMatch[1] ?? '', 10),
        oldLines: hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10),
        newStart: Number.parseInt(hunkMatch[3] ?? '', 10),
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

export function indexHunks(files: DiffFile[]) {
  const index = new Map<string, DiffHunk & Pick<DiffFile, 'path' | 'status'>>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      index.set(hunk.id, { ...hunk, path: file.path, status: file.status });
    }
  }
  return index;
}

export function listHunkIds(files: DiffFile[]) {
  const ids: string[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) ids.push(hunk.id);
  }
  return ids;
}
