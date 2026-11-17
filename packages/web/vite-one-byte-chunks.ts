import { parseAst, transformWithEsbuild, type Plugin, type Rollup } from 'vite';

/**
 * Keeps script chunks one byte per character in the browser's memory.
 *
 * Chromium keeps every loaded script's source text for the page's lifetime
 * (lazy compilation and `Function#toString` read it), and a text with any
 * character above U+00FF is held at two bytes per character. Vite writes
 * chunks as UTF-8, so a handful of ellipses or arrows in a 4 MB chunk doubled
 * what the whole chunk cost: the main chunk held 8 MB for 245 such characters.
 * A chunk whose escaped form (`\uXXXX`) is still shorter than twice its length
 * is reprinted with esbuild's ASCII charset, which escapes inside strings,
 * template literals and identifiers. A chunk that is mostly non-Latin text,
 * such as a locale dictionary, stays as it is: escaping it would cost more
 * than the two-byte form.
 *
 * A build with source maps is left alone: the reprint would need the emitted
 * map asset and its reference rewritten too, and those builds are for
 * attribution, not for what a user runs.
 */
const ESCAPED_EXTRA_CHARS = 5;
// A chunk this large left two-byte is worth a build warning.
const LARGE_CHUNK_CHARS = 256 * 1024;

const wideCodeUnits = (code: string): number => {
  let count = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) > 0xff) count += 1;
  }
  return count;
};

/**
 * Escapes the wide characters of a regular expression literal. `\uXXXX` means
 * the same character there, inside a class or not, with or without the `u`
 * flag; an astral character is written as its two surrogate escapes, which
 * those patterns read as the same pair. A character escaped with a backslash
 * loses that backslash, since a doubled one would mean a literal backslash
 * followed by "u2026".
 */
export const escapeRemainingWide = (code: string): string => code.replace(/(\\*)([Ā-\u{10FFFF}])/gu, (_match, slashes: string, char: string) => {
  const escaped = Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join('');
  return `${slashes.length % 2 === 1 ? slashes.slice(1) : slashes}${escaped}`;
});

type Span = { start: number; end: number };

// SAFETY: Rollup's parser sets `start` and `end` on every node; its types
// declare them on the program only.
const spanOf = (node: Rollup.AstNode): Span => node as Rollup.AstNode & Span;

const collectRegexRanges = (node: Rollup.AstNode, ranges: Array<[number, number]>): void => {
  if (node.type === 'Literal' && 'regex' in node && node.regex) {
    const { start, end } = spanOf(node);
    ranges.push([start, end]);
    return;
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child instanceof Object && 'type' in child) collectRegexRanges(child, ranges);
    }
  }
};

/**
 * esbuild's ASCII charset leaves regular expression literals and the raw text
 * of tagged templates alone. A regex takes `\uXXXX` with the same meaning; a
 * tagged template does not (`String.raw` would read the escape itself). So the
 * wide characters left are escaped when every one of them sits in a regex
 * literal; otherwise this returns null and the chunk is not rewritten.
 */
export const escapeRegexLiterals = (code: string): string | null => {
  const ranges: Array<[number, number]> = [];
  collectRegexRanges(parseAst(code), ranges);
  ranges.sort((left, right) => left[0] - right[0]);
  let result = '';
  let from = 0;
  for (const [start, end] of ranges) {
    result += code.slice(from, start) + escapeRemainingWide(code.slice(start, end));
    from = end;
  }
  result += code.slice(from);
  return wideCodeUnits(result) === 0 ? result : null;
};

export const oneByteChunksPlugin = (): Plugin => ({
  name: 'openchamber-one-byte-chunks',
  apply: 'build',
  enforce: 'post',
  async generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'chunk' || output.map) continue;
      const wide = wideCodeUnits(output.code);
      if (wide === 0 || output.code.length + wide * ESCAPED_EXTRA_CHARS >= output.code.length * 2) continue;
      const result = await transformWithEsbuild(output.code, output.fileName, {
        loader: 'js',
        charset: 'ascii',
        minifyWhitespace: true,
        legalComments: 'none',
        sourcemap: false,
      });
      const escaped = escapeRegexLiterals(result.code);
      if (escaped !== null) {
        output.code = escaped;
      } else if (output.code.length >= LARGE_CHUNK_CHARS) {
        // Raw template text (String.raw, a tagged template) keeps its
        // characters, so one of them there doubles what the whole chunk costs.
        const at = result.code.search(/[Ā-\u{10FFFF}]/u);
        this.warn(`${output.fileName} stays two bytes per character (${(output.code.length / 1048576).toFixed(1)} MB) because of a non-Latin character in raw template text: ${JSON.stringify(result.code.slice(Math.max(0, at - 60), at + 20))}`);
      }
    }
  },
});
