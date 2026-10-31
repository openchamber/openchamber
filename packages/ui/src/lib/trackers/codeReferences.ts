/**
 * Code references in an item's description: `path/to/file.ext` optionally
 * followed by `:NN`. The description renderer (`remarkCodeReferences`) splits
 * its text on these and links each one to the file it names.
 *
 * Two shapes match. A path with at least one `/` takes any extension of one to
 * four word characters; a bare file name must carry a known code extension, so
 * version numbers (`v1.2.3`) and other dotted words stay text. A match may not
 * start right after a word, path or URL character, which keeps the tail of a
 * URL (`https://host/path/file.ts`) from reading as a file path.
 */

export type CodeReference = {
  /** The whole matched text, line number included. */
  text: string;
  /** The file path without the line number, as the text spells it. */
  filePath: string;
  /** The `:NN` line number, or null when the text names no line. */
  line: number | null;
};

/** Extensions a bare file name reads as code without a directory before it. Each is at most four word characters. */
const KNOWN_CODE_EXTENSIONS = [
  'bash', 'c', 'cc', 'clj', 'cpp', 'cs', 'css', 'cts', 'cxx', 'dart', 'erl', 'ex', 'exs', 'fish', 'go', 'h', 'hpp',
  'htm', 'html', 'hs', 'ini', 'jl', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'lua', 'm', 'mjs', 'mm', 'mts',
  'nix', 'php', 'pl', 'pm', 'proto', 'py', 'r', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'tcl', 'tf', 'toml', 'ts',
  'tsx', 'vb', 'vue', 'xml', 'yml', 'yaml', 'zsh',
].join('|');

const CODE_REFERENCE_PATTERN = new RegExp(
  String.raw`(?<![\w@./\\-])((?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,4}|[\w-]+\.(?:${KNOWN_CODE_EXTENSIONS}))(?::(\d{1,5}))?(?![\w.])`,
  'gi',
);

export type CodeReferenceSegment =
  | { kind: 'text'; value: string }
  | { kind: 'reference'; reference: CodeReference };

/**
 * The text split around its code references, in order; null when none match.
 * The description renderer builds its links from these segments.
 */
export function splitCodeReferences(text: string): CodeReferenceSegment[] | null {
  const segments: CodeReferenceSegment[] = [];
  let offset = 0;
  for (const match of text.matchAll(CODE_REFERENCE_PATTERN)) {
    const filePath = match[1];
    const digits = match[2];
    if (!filePath) continue;
    if (match.index > offset) segments.push({ kind: 'text', value: text.slice(offset, match.index) });
    segments.push({
      kind: 'reference',
      reference: { text: match[0], filePath, line: digits ? Number(digits) : null },
    });
    offset = match.index + match[0].length;
  }
  if (segments.length === 0) return null;
  if (offset < text.length) segments.push({ kind: 'text', value: text.slice(offset) });
  return segments;
}

/** Every code reference in the text, in order; null when the text contains none. */
export function parseCodeReferences(text: string): CodeReference[] | null {
  const segments = splitCodeReferences(text);
  if (!segments) return null;
  const references = segments.flatMap((segment) => (segment.kind === 'reference' ? [segment.reference] : []));
  return references.length > 0 ? references : null;
}
