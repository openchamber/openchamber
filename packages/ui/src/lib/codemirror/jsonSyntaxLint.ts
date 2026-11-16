import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { jsonLanguage } from '@codemirror/lang-json';
import { linter, type Diagnostic } from '@codemirror/lint';
import stripJsonComments from 'strip-json-comments';


const MAX_LINTED_CHARS = 1_000_000;
const LINTED_EXTENSIONS = new Set(['json', 'jsonc', 'geojson']);

export const isLintedJsonPath = (filePath: string): boolean => {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && LINTED_EXTENSIONS.has(name.slice(dot + 1));
};

export const findJsonSyntaxError = (text: string): number | null => {
  if (text.trim() === '') return null;
  const tree = jsonLanguage.parser.parse(stripJsonComments(text, { trailingCommas: true }));
  let errorAt: number | null = null;
  tree.iterate({
    enter: (node) => {
      if (errorAt !== null) return false;
      if (node.type.isError) {
        errorAt = node.from;
        return false;
      }
      return undefined;
    },
  });
  return errorAt;
};

type JsonLintTheme = { error: string; tooltipBackground: string; tooltipForeground: string; border: string };

export const jsonSyntaxLint = (message: string, colors: JsonLintTheme): Extension => [
  linter((view): Diagnostic[] => {
    const { doc } = view.state;
    if (doc.length > MAX_LINTED_CHARS) return [];
    const at = findJsonSyntaxError(doc.toString());
    if (at === null) return [];
    const to = at < doc.length && doc.sliceString(at, at + 1) !== '\n' ? at + 1 : at;
    return [{ from: at, to, severity: 'error', message }];
  }, { delay: 500 }),
  EditorView.theme({
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: `underline wavy ${colors.error}`,
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '3px',
    },
    '.cm-lintPoint-error:after': { borderBottomColor: colors.error },
    '.cm-tooltip:has(> .cm-tooltip-lint)': {
      backgroundColor: colors.tooltipBackground,
      color: colors.tooltipForeground,
      border: `1px solid ${colors.border}`,
      borderRadius: '8px',
      overflow: 'hidden',
    },
    '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '0.75rem', padding: '4px 8px' },
    '.cm-diagnostic-error': { borderLeft: `3px solid ${colors.error}` },
  }),
];
