import React from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { EditorState, RangeSetBuilder, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * The note editor: one surface that is always editable and always reads as
 * formatted text.
 *
 * Notes used to open rendered and turn into a plain textarea on click, so the
 * same note looked like two different things depending on whether you were
 * touching it. Here headings, emphasis, code and links keep their look while
 * you type. Markdown markers (`#`, `**`, backticks, link targets) are hidden
 * except on the lines the cursor is on, where you need them to edit; without
 * focus every line shows formatted. List markers become bullets.
 *
 * The text is plain Markdown in and out; nothing here changes what is stored.
 */

/** Marker nodes hidden off the cursor's lines. */
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'QuoteMark']);

const HEADING_LINE_CLASS = new Map([
  ['ATXHeading1', 'cm-note-h1'],
  ['ATXHeading2', 'cm-note-h2'],
  ['ATXHeading3', 'cm-note-h3'],
  ['ATXHeading4', 'cm-note-h4'],
  ['ATXHeading5', 'cm-note-h4'],
  ['ATXHeading6', 'cm-note-h4'],
]);

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'cm-note-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}

const bulletWidget = Decoration.replace({ widget: new BulletWidget() });
const hiddenMark = Decoration.replace({});
const codeBlockLine = Decoration.line({ class: 'cm-note-codeblock' });
const quoteLine = Decoration.line({ class: 'cm-note-quote' });
const inlineCode = Decoration.mark({ class: 'cm-note-inline-code' });

/**
 * Parsing budget for one decoration pass. A note is capped at 3000 characters,
 * so finishing the parse here is cheap and keeps the first paint formatted.
 */
const PARSE_TIMEOUT_MS = 200;

/** Line numbers the selection touches; their markers stay visible. */
const activeLines = (view: EditorView): Set<number> => {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
};

const buildDecorations = (view: EditorView): DecorationSet => {
  const { state } = view;
  const active = activeLines(view);
  const isActive = (position: number) => active.has(state.doc.lineAt(position).number);
  const marks: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Decoration>();

  // The state's tree only reaches as far as the background parser has run.
  // Decorating from it leaves the markers on the tail of the note visible, so
  // finish the parse first and fall back to the partial tree only if it runs
  // out of budget; the plugin rebuilds when the tree changes.
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const headingClass = HEADING_LINE_CLASS.get(node.name);
        if (headingClass) {
          const line = state.doc.lineAt(node.from);
          lineClasses.set(line.from, Decoration.line({ class: headingClass }));
          return;
        }
        if (node.name === 'FencedCode' || node.name === 'Blockquote') {
          const decoration = node.name === 'FencedCode' ? codeBlockLine : quoteLine;
          for (let line = state.doc.lineAt(node.from); ; line = state.doc.line(line.number + 1)) {
            lineClasses.set(line.from, decoration);
            if (line.to >= node.to || line.number === state.doc.lines) break;
          }
          // Fences and code stay as typed; only quote markers are hidden.
          return node.name === 'Blockquote';
        }
        if (node.name === 'InlineCode') {
          marks.push(inlineCode.range(node.from, node.to));
          // Its backticks are hidden below like any other marker.
        }
        if (node.name === 'ListMark' && !isActive(node.from)) {
          const text = state.doc.sliceString(node.from, node.to);
          // Ordered lists keep their numbers.
          if (text === '-' || text === '*' || text === '+') marks.push(bulletWidget.range(node.from, node.to));
          return;
        }
        if (!HIDDEN_MARKS.has(node.name) || isActive(node.from)) return;
        let end = node.to;
        // "# Title" and "> quote" hide the space after the marker too.
        if ((node.name === 'HeaderMark' || node.name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end += 1;
        if (node.name === 'URL' && node.node.parent?.name !== 'Link') return;
        if (end > node.from) marks.push(hiddenMark.range(node.from, end));
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  const all: Range<Decoration>[] = [
    ...Array.from(lineClasses, ([position, decoration]) => decoration.range(position)),
    ...marks,
  ].sort((left, right) => left.from - right.from || left.value.startSide - right.value.startSide);
  for (const range of all) builder.add(range.from, range.to, range.value);
  return builder.finish();
};

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged
      || update.viewportChanged
      || update.selectionSet
      || update.focusChanged
      // The background parser publishes a finished tree as a state change, not
      // a document change; rebuild when it does.
      || syntaxTree(update.state) !== syntaxTree(update.startState)
    ) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

const noteHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--primary)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted-foreground)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },
  { tag: tags.quote, color: 'var(--muted-foreground)' },
]);

const noteTheme = EditorView.theme({
  '&': { height: '100%', color: 'inherit', backgroundColor: 'transparent', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '0 0 2rem', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-note-h1': { fontSize: '1.5em', fontWeight: '600', paddingTop: '0.4em' },
  '.cm-note-h2': { fontSize: '1.3em', fontWeight: '600', paddingTop: '0.3em' },
  '.cm-note-h3': { fontSize: '1.15em', fontWeight: '600', paddingTop: '0.2em' },
  '.cm-note-h4': { fontWeight: '600' },
  // The same chip the rendered Markdown draws for inline code (index.css).
  '.cm-note-inline-code': {
    backgroundColor: 'color-mix(in srgb, var(--markdown-inline-code-bg, var(--surface-subtle)) 50%, transparent)',
    color: 'color-mix(in srgb, var(--markdown-inline-code, var(--foreground)) 90%, transparent)',
    borderRadius: '0.375rem',
    padding: '0.1rem 0.35rem',
  },
  '.cm-note-bullet': { color: 'var(--muted-foreground)', paddingInlineEnd: '0.1em' },
  '.cm-note-codeblock': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
    backgroundColor: 'var(--surface-muted)',
    paddingInline: '0.75em',
  },
  '.cm-note-quote': {
    color: 'var(--muted-foreground)',
    borderInlineStart: '2px solid var(--interactive-border)',
    paddingInlineStart: '0.75em',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

export const NoteEditor: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  ariaLabel: string;
  maxLength: number;
}> = ({ value, onChange, onBlur, ariaLabel, maxLength }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  // The view is built once; the callbacks it calls must stay current.
  const onChangeRef = React.useRef(onChange);
  const onBlurRef = React.useRef(onBlur);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(noteHighlight),
          livePreview,
          noteTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'true' }),
          // The server caps a note's length; typing past it does nothing.
          EditorState.changeFilter.of((transaction) => transaction.newDoc.length <= maxLength),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              onBlurRef.current();
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Built once per mounted note; later values arrive through the effect below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A body adopted from elsewhere (an agent, another window) replaces the text;
  // the note view only passes one in while the user's edits are saved.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className="h-full min-h-0 typography-markdown-body text-foreground" />;
};
