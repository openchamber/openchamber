import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, Text, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, type ViewUpdate } from '@codemirror/view';
import { parseDiffFromFile } from '@pierre/diffs';

// Git change markers beside the line numbers, like VS Code's quick diff: the
// open document is compared with the file's git baseline and every changed
// line gets a bar. The comparison runs after typing pauses; in between, the
// existing markers move with the edits. Clicking a bar opens that change in
// place: the baseline lines show under it with a button that puts them back.

type GitLineChange = 'added' | 'modified' | 'deleted' | 'deletedAbove';

type GitHunk = {
  kind: 'added' | 'modified' | 'deleted';
  /** Range of the current document the change covers; empty for a removal. */
  from: number;
  to: number;
  /** The baseline's lines for that range, line breaks included. */
  original: string;
};

const RECOMPUTE_DELAY_MS = 300;
// Past this size a line diff on every pause costs more than the markers are
// worth; such files simply show none.
const MAX_DIFFED_CHARS = 1_000_000;

/** Changes of `current` against `baseline`, in document order. */
export const computeGitHunks = (baseline: string, current: string): GitHunk[] => {
  if (baseline === current) return [];
  const diff = parseDiffFromFile({ name: 'file', contents: baseline }, { name: 'file', contents: current });
  // Both line lists hold whole lines with their breaks, so offsets add up.
  const lineStarts = [0];
  for (const line of diff.additionLines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length);
  const offsetOfLine = (index: number) => lineStarts[Math.min(index, lineStarts.length - 1)];
  const hunks: GitHunk[] = [];
  for (const hunk of diff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== 'change') continue;
      // The whole file emptied reports index -1.
      const first = Math.max(block.additionLineIndex, 0);
      hunks.push({
        kind: block.additions === 0 ? 'deleted' : block.deletions === 0 ? 'added' : 'modified',
        from: offsetOfLine(first),
        to: offsetOfLine(first + block.additions),
        original: diff.deletionLines.slice(block.deletionLineIndex, block.deletionLineIndex + block.deletions).join(''),
      });
    }
  }
  return hunks;
};

/** Start of the line whose gutter shows the hunk's first marker. */
const markerLineStart = (doc: Text, hunk: GitHunk): number => (
  hunk.kind === 'deleted' && hunk.from > 0 ? doc.lineAt(hunk.from - 1).from : doc.lineAt(Math.min(hunk.from, doc.length)).from
);

/**
 * The marker of every line, keyed by 1-based line. `deleted` marks the line
 * below which lines were removed; `deletedAbove` marks line 1 when the removal
 * was at the very top.
 */
const lineChangesOf = (doc: Text, hunks: readonly GitHunk[]): Map<number, GitLineChange> => {
  const changes = new Map<number, GitLineChange>();
  for (const hunk of hunks) {
    if (hunk.kind === 'deleted') {
      const line = doc.lineAt(markerLineStart(doc, hunk)).number;
      if (!changes.has(line)) changes.set(line, hunk.from === 0 ? 'deletedAbove' : 'deleted');
      continue;
    }
    const first = doc.lineAt(hunk.from).number;
    const last = doc.lineAt(Math.max(hunk.from, hunk.to - 1)).number;
    for (let line = first; line <= last; line += 1) changes.set(line, hunk.kind);
  }
  return changes;
};

/** Line markers of `current` against `baseline`, keyed by 1-based line. */
export const computeGitLineChanges = (baseline: string, current: string): Map<number, GitLineChange> => (
  lineChangesOf(Text.of(current.split('\n')), computeGitHunks(baseline, current))
);

class GitChangeMarker extends GutterMarker {
  constructor(readonly kind: GitLineChange) {
    super();
  }

  eq(other: GitChangeMarker): boolean {
    return other.kind === this.kind;
  }

  toDOM(): Node {
    const element = document.createElement('div');
    element.className = `cm-git-change cm-git-change-${this.kind}`;
    return element;
  }
}

const MARKERS = {
  added: new GitChangeMarker('added'),
  modified: new GitChangeMarker('modified'),
  deleted: new GitChangeMarker('deleted'),
  deletedAbove: new GitChangeMarker('deletedAbove'),
} satisfies Record<GitLineChange, GitChangeMarker>;

const buildMarkers = (doc: Text, hunks: readonly GitHunk[]): RangeSet<GutterMarker> => {
  const changes = lineChangesOf(doc, hunks);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const lineNumber of [...changes.keys()].sort((a, b) => a - b)) {
    const kind = changes.get(lineNumber);
    if (kind) builder.add(doc.line(lineNumber).from, doc.line(lineNumber).from, MARKERS[kind]);
  }
  return builder.finish();
};

type GitChangeState = {
  hunks: readonly GitHunk[];
  markers: RangeSet<GutterMarker>;
  /** The change shown in place, if any. */
  open: GitHunk | null;
};

const EMPTY_STATE: GitChangeState = { hunks: [], markers: RangeSet.empty, open: null };

const setBaselineEffect = StateEffect.define<string | null>();
const setHunksEffect = StateEffect.define<readonly GitHunk[]>();
const openHunkEffect = StateEffect.define<GitHunk | null>();

const baselineField = StateField.define<string | null>({
  create: () => null,
  update(baseline, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setBaselineEffect)) return effect.value;
    }
    return baseline;
  },
});

const overlaps = (a: GitHunk, b: GitHunk) => a.from <= b.to && b.from <= a.to;

const gitChangeField = StateField.define<GitChangeState>({
  create: () => EMPTY_STATE,
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) {
      const { changes } = transaction;
      const mapHunk = (hunk: GitHunk): GitHunk => ({ ...hunk, from: changes.mapPos(hunk.from, -1), to: changes.mapPos(hunk.to, 1) });
      next = {
        hunks: next.hunks.map(mapHunk),
        markers: next.markers.map(changes),
        open: next.open && mapHunk(next.open),
      };
    }
    for (const effect of transaction.effects) {
      if (effect.is(setBaselineEffect) && effect.value === null) next = EMPTY_STATE;
      if (effect.is(setHunksEffect)) {
        // A fresh diff keeps the open change open while it still exists.
        const open = next.open;
        next = {
          hunks: effect.value,
          markers: buildMarkers(transaction.newDoc, effect.value),
          open: open ? effect.value.find((hunk) => overlaps(hunk, open)) ?? null : null,
        };
      }
      if (effect.is(openHunkEffect)) next = { ...next, open: effect.value };
    }
    return next;
  },
});

const hunkAtLine = (state: EditorState, lineStart: number): GitHunk | null => {
  const { doc } = state;
  for (const hunk of state.field(gitChangeField).hunks) {
    if (hunk.kind === 'deleted') {
      if (markerLineStart(doc, hunk) === lineStart) return hunk;
    } else if (lineStart >= doc.lineAt(hunk.from).from && lineStart < hunk.to) {
      return hunk;
    }
  }
  return null;
};

type GitHunkLabels = { revert: string; close: string };

const hunkButton = (label: string, icon: string | null, onClick: () => void): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-git-hunk-button';
  if (icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#oc-${icon}`);
    svg.appendChild(use);
    button.appendChild(svg);
  }
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  // Keep the editor's selection and focus where they were.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', onClick);
  return button;
};

class GitHunkWidget extends WidgetType {
  constructor(readonly hunk: GitHunk, readonly labels: GitHunkLabels, readonly canRevert: boolean) {
    super();
  }

  eq(other: GitHunkWidget): boolean {
    return other.hunk.original === this.hunk.original
      && other.hunk.kind === this.hunk.kind
      && other.canRevert === this.canRevert
      && other.labels.revert === this.labels.revert
      && other.labels.close === this.labels.close;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'cm-git-hunk';
    const actions = document.createElement('div');
    actions.className = 'cm-git-hunk-actions';
    if (this.canRevert) {
      actions.appendChild(hunkButton(this.labels.revert, 'arrow-go-back', () => {
        const open = view.state.field(gitChangeField).open;
        if (!open) return;
        view.dispatch({
          changes: { from: open.from, to: open.to, insert: open.original },
          effects: openHunkEffect.of(null),
          userEvent: 'input.revert',
        });
        view.focus();
      }));
    }
    // Spelled out: a bare cross next to Revert read as "discard the change".
    actions.appendChild(hunkButton(this.labels.close, null, () => {
      view.dispatch({ effects: openHunkEffect.of(null) });
      view.focus();
    }));
    root.appendChild(actions);
    if (this.hunk.original) {
      const original = document.createElement('pre');
      original.className = 'cm-git-hunk-original';
      original.textContent = this.hunk.original.replace(/\r?\n$/, '');
      root.appendChild(original);
    }
    return root;
  }
}

const hunkDecorations = (labels: GitHunkLabels) => EditorView.decorations.compute([gitChangeField, EditorState.readOnly], (state): DecorationSet => {
  const { open } = state.field(gitChangeField);
  if (!open) return Decoration.none;
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];
  if (open.kind !== 'deleted') {
    const lineClass = Decoration.line({ class: `cm-git-hunk-line cm-git-hunk-line-${open.kind}` });
    for (let pos = doc.lineAt(open.from).from; pos < open.to && pos <= doc.length; pos = doc.lineAt(pos).to + 1) {
      ranges.push(lineClass.range(pos));
    }
  }
  const widget = new GitHunkWidget(open, labels, !state.readOnly);
  if (open.kind === 'deleted' && open.from === 0) {
    ranges.push(Decoration.widget({ widget, block: true, side: -1 }).range(0));
  } else {
    const anchor = doc.lineAt(open.kind === 'deleted' ? open.from - 1 : Math.max(open.from, open.to - 1)).to;
    ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(anchor));
  }
  return Decoration.set(ranges, true);
});

const recomputePlugin = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    const baselineChanged = update.transactions.some((transaction) => (
      transaction.effects.some((effect) => effect.is(setBaselineEffect))
    ));
    if (baselineChanged) this.schedule(0);
    else if (update.docChanged) this.schedule(RECOMPUTE_DELAY_MS);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const { state } = this.view;
      const baseline = state.field(baselineField);
      if (baseline === null) return;
      const current = state.doc.toString();
      const tooLarge = Math.max(baseline.length, current.length) > MAX_DIFFED_CHARS;
      this.view.dispatch({ effects: setHunksEffect.of(tooLarge ? [] : computeGitHunks(baseline, current)) });
    }, delay);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
});

type GitChangeColors = { added: string; modified: string; removed: string };

/** The gutter plus its theme; feed it a baseline with `setGitChangeBaseline`. */
export const gitChangeGutter = (colors: GitChangeColors, labels: GitHunkLabels): Extension => [
  baselineField,
  gitChangeField,
  recomputePlugin,
  hunkDecorations(labels),
  gutter({
    class: 'cm-git-gutter',
    markers: (view) => view.state.field(gitChangeField).markers,
    domEventHandlers: {
      mousedown: (view, line) => {
        const hunk = hunkAtLine(view.state, line.from);
        if (!hunk) return false;
        const { open } = view.state.field(gitChangeField);
        view.dispatch({ effects: openHunkEffect.of(open && overlaps(open, hunk) ? null : hunk) });
        return true;
      },
    },
  }),
  keymap.of([{
    key: 'Escape',
    run: (view) => {
      if (!view.state.field(gitChangeField).open) return false;
      view.dispatch({ effects: openHunkEffect.of(null) });
      return true;
    },
  }]),
  EditorView.theme({
    '.cm-git-gutter': { width: '6px' },
    '.cm-git-gutter .cm-gutterElement': { position: 'relative' },
    '.cm-git-change': { position: 'absolute', left: '1px', width: '3px', top: '0', bottom: '0', cursor: 'pointer' },
    '.cm-git-change-added': { backgroundColor: colors.added },
    '.cm-git-change-modified': { backgroundColor: colors.modified },
    // A removal sits between lines: a short bar straddling the boundary.
    '.cm-git-change-deleted, .cm-git-change-deletedAbove': {
      top: 'auto',
      height: '6px',
      width: '5px',
      left: '0',
      backgroundColor: colors.removed,
      clipPath: 'polygon(0 0, 100% 50%, 0 100%)',
    },
    '.cm-git-change-deleted': { bottom: '-3px' },
    '.cm-git-change-deletedAbove': { top: '-3px', bottom: 'auto' },
    '.cm-git-hunk-line-added': { backgroundColor: `color-mix(in srgb, ${colors.added} 12%, transparent)` },
    '.cm-git-hunk-line-modified': { backgroundColor: `color-mix(in srgb, ${colors.modified} 12%, transparent)` },
    '.cm-git-hunk': { padding: '2px 0' },
    // At the start of the line: with wrapping off the widget is as wide as the
    // longest line, and its end can sit far outside the view.
    '.cm-git-hunk-actions': { display: 'flex', gap: '2px', padding: '0 2px' },
    '.cm-git-hunk-button': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '22px',
      padding: '0 6px',
      border: 'none',
      borderRadius: '4px',
      background: 'transparent',
      color: 'var(--muted-foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: '12px',
      cursor: 'pointer',
    },
    '.cm-git-hunk-button:hover': { color: 'var(--foreground)' },
    '.cm-git-hunk-button svg': { width: '14px', height: '14px', fill: 'currentColor' },
    '.cm-git-hunk-original': {
      margin: '0',
      padding: '0 2px 0 6px',
      font: 'inherit',
      whiteSpace: 'pre',
      backgroundColor: `color-mix(in srgb, ${colors.removed} 14%, transparent)`,
    },
  }),
];

/** Replaces the baseline the markers compare against; `null` clears them. */
export const setGitChangeBaseline = (view: EditorView, baseline: string | null): void => {
  if (view.state.field(baselineField, false) === undefined) return;
  view.dispatch({ effects: setBaselineEffect.of(baseline) });
};
