/**
 * The composer's prompt language as a CodeMirror extension.
 *
 * `tokenizeComposer` already answers "what does this text mean"; this module
 * is the thin adapter that turns its ranges into mark decorations and keeps
 * them in sync with the document and with the workspace registries.
 *
 * Why this replaces the mirror overlay: a transparent textarea painted over a
 * mirror div can only use styles that do not change glyph advance width, or
 * the two layers drift apart and the caret lands in the wrong place. That is
 * why bold and italic were never highlighted, and why the overlay had to be
 * switched off entirely on mobile. CodeMirror owns the caret and the text, so
 * there is no second layer to keep aligned and no metric restriction.
 */

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, Direction, EditorView, type DecorationSet } from '@codemirror/view';

import { resolveHighlightSegments, DEFAULT_HIGHLIGHT_CLASS, type HighlightRange } from '../../composerHighlight';
import { tokenizeComposer, type ComposerLanguageContext } from '../language/tokenize';

/**
 * Replace the workspace knowledge the tokenizer resolves against. Dispatched
 * when the agent, command, skill, snippet or attachment registries change —
 * not on every keystroke, which only changes the document.
 */
export const setLanguageContext = StateEffect.define<ComposerLanguageContext>();

/**
 * The context lives in editor state rather than in a closure so the decoration
 * field can recompute from `(document, context)` alone, and so a context change
 * repaints without remounting the view.
 */
const languageContextField = StateField.define<ComposerLanguageContext>({
    create: () => EMPTY_CONTEXT,
    update(value, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setLanguageContext)) return effect.value;
        }
        return value;
    },
});

const EMPTY_CONTEXT: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
};

const technicalStyles = new Set<HighlightRange['style']>([
    'code', 'codeFence', 'path', 'linkUrl',
    'mentionFile', 'mentionAgent', 'mentionCommand', 'mentionSnippet',
]);

const ltrIsolate = Decoration.mark({
    attributes: { dir: 'ltr', style: 'unicode-bidi: isolate' },
    bidiIsolate: Direction.LTR,
});

function technicalIsolates(ranges: HighlightRange[]): DecorationSet {
    const technical = ranges
        .filter((range) => range.start < range.end && technicalStyles.has(range.style))
        .sort((a, b) => a.start - b.start || b.end - a.end);
    const builder = new RangeSetBuilder<Decoration>();
    let start = -1;
    let end = -1;
    // One isolation boundary per technical fragment, outside syntax colors.
    // Overlapping highlights must not split paths or code into separate runs.
    for (const range of technical) {
        if (range.start <= end) {
            end = Math.max(end, range.end);
        } else {
            if (start >= 0) builder.add(start, end, ltrIsolate);
            start = range.start;
            end = range.end;
        }
    }
    if (start >= 0) builder.add(start, end, ltrIsolate);
    return builder.finish();
}

/**
 * Reuse the prompt's existing tokenization for both color and direction.
 * The composer already retokenizes on edits; bidi adds no second text scan.
 */
function buildDecorations(text: string, context: ComposerLanguageContext) {
    const ranges = tokenizeComposer(text, context);
    const builder = new RangeSetBuilder<Decoration>();
    for (const segment of resolveHighlightSegments(text, ranges)) {
        // Unstyled stretches need no decoration — the editor's own base text
        // color already renders them.
        if (segment.className === DEFAULT_HIGHLIGHT_CLASS) continue;
        builder.add(segment.start, segment.end, Decoration.mark({ class: segment.className }));
    }
    return {
        highlights: builder.finish(),
        isolates: context.inputMode === 'shell' && text.length > 0
            ? Decoration.set([ltrIsolate.range(0, text.length)])
            : technicalIsolates(ranges),
    };
}

const decorationField = StateField.define<ReturnType<typeof buildDecorations>>({
    create: (state) => buildDecorations(state.doc.toString(), state.field(languageContextField)),
    update(value, transaction) {
        const contextChanged = transaction.effects.some((effect) => effect.is(setLanguageContext));
        if (!transaction.docChanged && !contextChanged) return value;
        return buildDecorations(
            transaction.state.doc.toString(),
            transaction.state.field(languageContextField),
        );
    },
    provide: (field) => [
        EditorView.decorations.from(field, (value) => value.highlights),
        EditorView.outerDecorations.from(field, (value) => value.isolates),
        EditorView.bidiIsolatedRanges.from(field, (value) => value.isolates),
    ],
});

/**
 * The composer language extension. Install once; feed it registry updates with
 * `setLanguageContext`.
 */
export function composerLanguage(initial: ComposerLanguageContext = EMPTY_CONTEXT) {
    return [
        languageContextField.init(() => initial),
        decorationField,
    ];
}
