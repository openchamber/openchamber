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
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import { resolveHighlightSegments, DEFAULT_HIGHLIGHT_CLASS } from '../../composerHighlight';
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

export const EMPTY_CONTEXT: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
};

/**
 * Decorations for the whole document. The composer holds a prompt, not a
 * source file: it is short enough that a full retokenize per change is
 * cheaper and far simpler than incremental mapping, and it keeps the editor
 * and the send path reading the exact same grammar.
 */
function buildDecorations(text: string, context: ComposerLanguageContext): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const segment of resolveHighlightSegments(text, tokenizeComposer(text, context))) {
        // Unstyled stretches need no decoration — the editor's own base text
        // color already renders them.
        if (segment.className === DEFAULT_HIGHLIGHT_CLASS) continue;
        builder.add(segment.start, segment.end, Decoration.mark({ class: segment.className }));
    }
    return builder.finish();
}

const decorationField = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state.doc.toString(), state.field(languageContextField)),
    update(value, transaction) {
        const contextChanged = transaction.effects.some((effect) => effect.is(setLanguageContext));
        if (!transaction.docChanged && !contextChanged) return value;
        return buildDecorations(
            transaction.state.doc.toString(),
            transaction.state.field(languageContextField),
        );
    },
    provide: (field) => EditorView.decorations.from(field),
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

/** The context currently in effect, for callers that need to read it back. */
export function readLanguageContext(view: EditorView): ComposerLanguageContext {
    return view.state.field(languageContextField);
}
