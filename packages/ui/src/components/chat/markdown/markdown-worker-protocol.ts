import type { Theme as ZedTheme } from '@pierre/highlights';
import type { VSCodeTextMateTheme } from '@/lib/shiki/vscodeTextMateTheme';

// Message protocol for the shared code highlighting Web Worker used by
// non-Markdown code views.
//
// The worker returns whole-block HTML, per-line HTML or themed token runs.
// Its CSS-variable themes are imported directly. CodeMirror supplies arbitrary
// theme definitions with its token requests.

/** One app theme in both formats: Highlights reads `zed`, Shiki `textmate`. */
export type CodeTokenTheme = { textmate: VSCodeTextMateTheme; zed: ZedTheme };

// A single styled run inside a line: [length, color, fontStyleBits].
// `color` is '' for default-foreground runs; fontStyleBits is Shiki's FontStyle
// bitmask (1=italic, 2=bold, 4=underline).
export type MarkdownTokenRun = [length: number, color: string, fontStyle: number];

export type MarkdownWorkerRequest =
  | { type: 'init' }
  // Highlight a whole block to ready-to-splice Shiki `<pre>` HTML. A block that
  // extends one highlighted before is tokenized from where that one ended;
  // `fullPass` asks for a fresh pass over the whole block instead.
  | { type: 'highlight'; id: number; code: string; lang: string; fullPass?: boolean }
  // Highlight a whole block but return per-line inner HTML (one entry per line),
  // so per-line layouts (diffs, gutters, virtualization) tokenize in ONE call
  // instead of one worker round-trip per line.
  | { type: 'highlightLines'; id: number; code: string; lang: string }
  // Tokenize with an arbitrary registered theme and return per-line styled runs
  // with offsets — for building CodeMirror decorations. `theme` is sent only
  // the first time a theme name is used; afterwards only `themeName` is sent
  // and the worker reuses the loaded theme.
  | { type: 'highlightTokens'; id: number; code: string; lang: string; themeName: string; theme?: CodeTokenTheme };

export type MarkdownWorkerResponse =
  | { type: 'highlight'; id: number; html: string }
  | { type: 'highlightLines'; id: number; lines: string[] }
  | { type: 'highlightTokens'; id: number; lines: MarkdownTokenRun[][] }
  | { type: 'error'; id: number; message: string };
