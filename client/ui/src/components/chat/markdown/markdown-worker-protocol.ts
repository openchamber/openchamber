// Message protocol for the markdown Shiki Web Worker.
//
// The worker tokenizes a complete code block off the main thread and returns
// ready-to-splice Shiki HTML. The theme is dependency-free and imported inside
// the worker directly, so it is not sent over postMessage.

// A single styled run inside a line: [length, color, fontStyleBits].
// `color` is '' for default-foreground runs; fontStyleBits is Shiki's FontStyle
// bitmask (1=italic, 2=bold, 4=underline).
export type MarkdownTokenRun = [length: number, color: string, fontStyle: number];

export type MarkdownWorkerRequest =
  | { type: 'init' }
  // Highlight a whole block to ready-to-splice Shiki `<pre>` HTML.
  | { type: 'highlight'; id: number; code: string; lang: string }
  // Highlight a whole block but return per-line inner HTML (one entry per line),
  // so per-line layouts (diffs, gutters, virtualization) tokenize in ONE call
  // instead of one worker round-trip per line.
  | { type: 'highlightLines'; id: number; code: string; lang: string }
  // Tokenize with an arbitrary registered theme and return per-line styled runs
  // with offsets — for building CodeMirror decorations. `theme` (a resolved
  // TextMate theme object) is sent only the first time a theme name is used;
  // afterwards only `themeName` is sent and the worker reuses the loaded theme.
  | { type: 'highlightTokens'; id: number; code: string; lang: string; themeName: string; theme?: unknown };

export type MarkdownWorkerResponse =
  | { type: 'highlight'; id: number; html: string }
  | { type: 'highlightLines'; id: number; lines: string[] }
  | { type: 'highlightTokens'; id: number; lines: MarkdownTokenRun[][] }
  | { type: 'error'; id: number; message: string };
