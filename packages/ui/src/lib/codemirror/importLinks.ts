import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView } from '@codemirror/view';
import { isMacOS } from '@/lib/utils';

// Cmd+click (Ctrl+click off macOS) on a relative import path opens the file it
// names, the way the browser follows a link. Only paths starting with `./` or
// `../` count: they name a file without guessing. Aliases and packages need
// the project's resolver settings and are left alone. Holding the key over
// such a path underlines it.

type ImportLink = { from: number; to: number; specifier: string };

const IMPORT_PARENTS = new Set(['ImportDeclaration', 'ExportDeclaration', 'DynamicImport']);

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

const isRequireArgument = (state: EditorState, argList: SyntaxNode): boolean => {
  const call = argList.parent;
  const callee = call?.firstChild;
  return call?.name === 'CallExpression' && !!callee && state.sliceDoc(callee.from, callee.to) === 'require';
};

/** The relative import path under `pos`, quotes excluded from the specifier. */
export const relativeImportAt = (state: EditorState, pos: number): ImportLink | null => {
  const tree = syntaxTree(state);
  const node = [tree.resolveInner(pos, 1), tree.resolveInner(pos, -1)].find((candidate) => candidate.name === 'String');
  const parent = node?.parent;
  if (!node || !parent) return null;
  if (!IMPORT_PARENTS.has(parent.name) && !(parent.name === 'ArgList' && isRequireArgument(state, parent))) return null;
  const specifier = state.sliceDoc(node.from + 1, node.to - 1);
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  return { from: node.from, to: node.to, specifier };
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte'];
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
// TypeScript's ESM style imports the compiled name of a source file.
const COMPILED_TO_SOURCE = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

const dirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/';

/** Joins a relative specifier onto a directory, folding `.` and `..`. */
export const joinPath = (directory: string, relative: string): string => {
  const parts = directory.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/') || '/';
};

/** Every path the specifier may mean, in the order a bundler tries them. */
export const importCandidates = (fromFile: string, specifier: string): string[] => {
  const base = joinPath(dirname(fromFile), specifier);
  const name = base.slice(base.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = extension ? base.slice(0, -extension.length) : base;
  return [
    base,
    ...(COMPILED_TO_SOURCE.get(extension) ?? []).map((source) => stem + source),
    ...SOURCE_EXTENSIONS.map((source) => base + source),
    ...INDEX_EXTENSIONS.map((source) => `${base}/index${source}`),
  ];
};

/** Names in a directory and whether each is a folder; null when it cannot be read. */
export type ListDirectoryNames = (directory: string) => Promise<ReadonlyMap<string, boolean> | null>;

type ImportResolution = { status: 'found'; path: string } | { status: 'missing' } | { status: 'failed' };

/**
 * The first candidate that exists as a file. A folder its parent's listing
 * does not show is skipped as missing; a listing that fails makes the lookup
 * `failed` unless another candidate is found, since the file may well be there.
 */
export const resolveRelativeImport = async (
  fromFile: string,
  specifier: string,
  listNames: ListDirectoryNames,
): Promise<ImportResolution> => {
  const listings = new Map<string, Promise<ReadonlyMap<string, boolean> | null>>();
  let failed = false;
  for (const candidate of importCandidates(fromFile, specifier)) {
    const directory = dirname(candidate);
    const parentListing = listings.get(dirname(directory));
    const parentNames = parentListing ? await parentListing : null;
    if (!listings.has(directory) && parentNames && parentNames.get(directory.slice(directory.lastIndexOf('/') + 1)) !== true) continue;
    let listing = listings.get(directory);
    if (!listing) {
      listing = listNames(directory);
      listings.set(directory, listing);
    }
    const names = await listing;
    if (!names) {
      failed = true;
      continue;
    }
    if (names.get(candidate.slice(candidate.lastIndexOf('/') + 1)) === false) return { status: 'found', path: candidate };
  }
  return failed ? { status: 'failed' } : { status: 'missing' };
};

const hasLinkModifier = (event: MouseEvent | KeyboardEvent) => (isMacOS() ? event.metaKey : event.ctrlKey);

const setHoveredLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'cm-import-link' });

const hoveredLinkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredLink)) return effect.value;
    }
    return transaction.docChanged ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (range) => (
    range ? Decoration.set([linkMark.range(range.from, range.to)]) : Decoration.none
  )),
});

const showHovered = (view: EditorView, range: { from: number; to: number } | null) => {
  const current = view.state.field(hoveredLinkField);
  if (current?.from === range?.from && current?.to === range?.to) return;
  view.dispatch({ effects: setHoveredLink.of(range) });
};

const linkAtEvent = (view: EditorView, event: MouseEvent): ImportLink | null => {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  return pos === null ? null : relativeImportAt(view.state, pos);
};

/** `openImport` gets the specifier of the clicked path. */
export const importLinks = (openImport: (specifier: string) => void): Extension => [
  hoveredLinkField,
  EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0 || !hasLinkModifier(event)) return false;
      const link = linkAtEvent(view, event);
      if (!link) return false;
      event.preventDefault();
      openImport(link.specifier);
      return true;
    },
    mousemove: (event, view) => {
      showHovered(view, hasLinkModifier(event) ? linkAtEvent(view, event) : null);
      return false;
    },
    mouseleave: (_event, view) => {
      showHovered(view, null);
      return false;
    },
    keyup: (event, view) => {
      if (!hasLinkModifier(event)) showHovered(view, null);
      return false;
    },
  }),
  EditorView.theme({
    '.cm-import-link': { textDecoration: 'underline', cursor: 'pointer' },
  }),
];
