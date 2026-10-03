import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from '@codemirror/view';
import { parseDiffFromFile } from '@pierre/diffs';

// Git change markers beside the line numbers, like VS Code's quick diff: the
// open document is compared with the file's git baseline and every changed
// line gets a bar. The comparison runs after typing pauses; in between, the
// existing markers move with the edits.

type GitLineChange = 'added' | 'modified' | 'deleted' | 'deletedAbove';

const RECOMPUTE_DELAY_MS = 300;
// Past this size a line diff on every pause costs more than the markers are
// worth; such files simply show none.
const MAX_DIFFED_CHARS = 1_000_000;

/**
 * Changes of `current` against `baseline`, keyed by 1-based line in
 * `current`. `deleted` marks the line below which lines were removed;
 * `deletedAbove` marks line 1 when the removal was at the very top.
 */
export const computeGitLineChanges = (baseline: string, current: string): Map<number, GitLineChange> => {
  const changes = new Map<number, GitLineChange>();
  if (baseline === current) return changes;
  const diff = parseDiffFromFile({ name: 'file', contents: baseline }, { name: 'file', contents: current });
  for (const hunk of diff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== 'change') continue;
      if (block.additions === 0) {
        // Removed at the very top, or the whole file emptied (index -1).
        const atTop = block.additionLineIndex <= 0;
        const line = atTop ? 1 : block.additionLineIndex;
        if (!changes.has(line)) changes.set(line, atTop ? 'deletedAbove' : 'deleted');
        continue;
      }
      const kind: GitLineChange = block.deletions === 0 ? 'added' : 'modified';
      for (let offset = 0; offset < block.additions; offset += 1) {
        changes.set(block.additionLineIndex + offset + 1, kind);
      }
    }
  }
  return changes;
};

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

const buildMarkers = (doc: Text, changes: Map<number, GitLineChange>): RangeSet<GutterMarker> => {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const lineNumber of [...changes.keys()].sort((a, b) => a - b)) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue;
    const kind = changes.get(lineNumber);
    if (kind) builder.add(doc.line(lineNumber).from, doc.line(lineNumber).from, MARKERS[kind]);
  }
  return builder.finish();
};

const setBaselineEffect = StateEffect.define<string | null>();
const setMarkersEffect = StateEffect.define<RangeSet<GutterMarker>>();

const baselineField = StateField.define<string | null>({
  create: () => null,
  update(baseline, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setBaselineEffect)) return effect.value;
    }
    return baseline;
  },
});

const markersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMarkersEffect)) return effect.value;
      if (effect.is(setBaselineEffect) && effect.value === null) return RangeSet.empty;
    }
    return transaction.docChanged ? markers.map(transaction.changes) : markers;
  },
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
      const current = state.doc.toString();
      const tooLarge = baseline !== null && Math.max(baseline.length, current.length) > MAX_DIFFED_CHARS;
      const markers = baseline === null || tooLarge
        ? RangeSet.empty
        : buildMarkers(state.doc, computeGitLineChanges(baseline, current));
      this.view.dispatch({ effects: setMarkersEffect.of(markers) });
    }, delay);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
});

type GitChangeColors = { added: string; modified: string; removed: string };

/** The gutter plus its theme; feed it a baseline with `setGitChangeBaseline`. */
export const gitChangeGutter = (colors: GitChangeColors): Extension => [
  baselineField,
  markersField,
  recomputePlugin,
  gutter({
    class: 'cm-git-gutter',
    markers: (view) => view.state.field(markersField),
  }),
  EditorView.theme({
    '.cm-git-gutter': { width: '6px' },
    '.cm-git-gutter .cm-gutterElement': { position: 'relative' },
    '.cm-git-change': { position: 'absolute', left: '1px', width: '3px', top: '0', bottom: '0' },
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
  }),
];

/** Replaces the baseline the markers compare against; `null` clears them. */
export const setGitChangeBaseline = (view: EditorView, baseline: string | null): void => {
  if (view.state.field(baselineField, false) === undefined) return;
  view.dispatch({ effects: setBaselineEffect.of(baseline) });
};
