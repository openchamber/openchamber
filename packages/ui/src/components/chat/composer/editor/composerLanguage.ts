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

import { RangeSetBuilder, StateEffect, StateField, type Transaction } from '@codemirror/state';
import { Decoration, Direction, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { INLINE_REFERENCE_CHIP_CLASS, SKILL_CHIP_ICON_HREF } from '@/lib/messages/inlineMessageLinks';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import { findAttachmentCitationRanges } from '../../attachmentCitations';
import { resolveHighlightSegments, DEFAULT_HIGHLIGHT_CLASS, type HighlightRange } from '../../composerHighlight';
import { filterKnownTokens, scanPrefixTokens } from '../language/prefixTokens';
import { tokenizeComposer, tokenizeMentions, type ComposerLanguageContext } from '../language/tokenize';

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
 * A reference drawn as the same chip the sent message shows: an attachment
 * citation (`[name.png]`) or a skill (`$name`). The document keeps the source
 * text, so sending, copying and undo see it unchanged; the range is atomic, so
 * the caret steps over the chip and one Backspace removes it whole.
 */
class ReferenceChipWidget extends WidgetType {
    constructor(readonly label: string, readonly title: string, readonly iconHref: string) {
        super();
    }

    eq(other: ReferenceChipWidget): boolean {
        return other.label === this.label && other.title === this.title && other.iconHref === this.iconHref;
    }

    toDOM(view: EditorView): HTMLElement {
        const doc = view.dom.ownerDocument;
        const chip = doc.createElement('span');
        chip.className = INLINE_REFERENCE_CHIP_CLASS;
        chip.title = this.title;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'block size-[1.1em] shrink-0');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', this.iconHref);
        svg.appendChild(use);
        chip.append(svg, doc.createTextNode(this.label));
        return chip;
    }

    // Clicks on the chip place the caret like clicks on text.
    ignoreEvent(): boolean {
        return false;
    }
}

const AGENT_CHIP_ICON_HREF = '#oc-robot-2';
const SNIPPET_CHIP_ICON_HREF = '#oc-file-text';
const FOLDER_CHIP_ICON_HREF = '#oc-folder-3-fill';

type ChipRange = { start: number; end: number; widget: ReferenceChipWidget };

const basename = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() || path;
};

/**
 * Chips for the references the composer recognizes: attachment citations,
 * file and agent mentions, skills and snippets. Commands keep their color.
 *
 * `typingEnd` is where the change being typed right now ended. A token ending
 * exactly there is still being written and stays text, so `$review` does not
 * turn into a chip on the way to `$review-pr` (or mid-sentence, where a space
 * already follows the caret). It becomes a chip once anything is typed after
 * it or an edit happens elsewhere. Citations are complete when inserted.
 */
function referenceChips(text: string, context: ComposerLanguageContext, typingEnd: number | null): DecorationSet {
    if (context.inputMode === 'shell' || !text) return Decoration.none;
    const themeVariant = context.fileIconVariant ?? 'dark';
    const chips: ChipRange[] = [];
    const addToken = (start: number, end: number, widget: ReferenceChipWidget) => {
        if (end !== typingEnd) chips.push({ start, end, widget });
    };

    const citedNames = [...context.attachmentFilenames, ...(context.pendingAttachmentFilenames ?? [])];
    if (citedNames.length > 0 && text.includes('[')) {
        for (const range of findAttachmentCitationRanges(text, citedNames)) {
            const filename = text.slice(range.start + 1, range.end - 1).trim();
            chips.push({
                ...range,
                widget: new ReferenceChipWidget(filename, filename, getFileTypeIconHref(filename, { themeVariant })),
            });
        }
    }

    if (text.includes('@')) {
        for (const mention of tokenizeMentions(text, context)) {
            const name = text.slice(mention.start + 1, mention.end);
            if (mention.kind === 'agent') {
                addToken(mention.start, mention.end, new ReferenceChipWidget(name, `@${name}`, AGENT_CHIP_ICON_HREF));
                continue;
            }
            const iconHref = /[\\/]$/.test(name) ? FOLDER_CHIP_ICON_HREF : getFileTypeIconHref(name, { themeVariant });
            addToken(mention.start, mention.end, new ReferenceChipWidget(basename(name), `@${name}`, iconHref));
        }
    }

    if (context.knownSkillNames) {
        for (const token of filterKnownTokens(scanPrefixTokens(text, '$'), context.knownSkillNames)) {
            addToken(token.start, token.end, new ReferenceChipWidget(token.name, `$${token.name}`, SKILL_CHIP_ICON_HREF));
        }
    }

    for (const token of filterKnownTokens(scanPrefixTokens(text, '#'), context.knownSnippetTriggers)) {
        addToken(token.start, token.end, new ReferenceChipWidget(token.name, `#${token.name}`, SNIPPET_CHIP_ICON_HREF));
    }

    chips.sort((a, b) => a.start - b.start);
    const builder = new RangeSetBuilder<Decoration>();
    let lastEnd = -1;
    for (const chip of chips) {
        if (chip.start < lastEnd) continue;
        builder.add(chip.start, chip.end, Decoration.replace({ widget: chip.widget }));
        lastEnd = chip.end;
    }
    return builder.finish();
}

/**
 * Reuse the prompt's existing tokenization for both color and direction.
 * The composer already retokenizes on edits; bidi adds no second text scan.
 */
function buildDecorations(text: string, context: ComposerLanguageContext, typingEnd: number | null = null) {
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
        chips: referenceChips(text, context, typingEnd),
        isolates: context.inputMode === 'shell' && text.length > 0
            ? Decoration.set([ltrIsolate.range(0, text.length)])
            : technicalIsolates(ranges),
    };
}

/** Where the change being typed ended, or null when the last edit was not typing. */
function typedChangeEnd(transaction: Transaction): number | null {
    if (!transaction.isUserEvent('input') && !transaction.isUserEvent('delete')) return null;
    let end: number | null = null;
    transaction.changes.iterChangedRanges((_fromA, _toA, _fromB, toB) => {
        end = toB;
    });
    return end;
}

type DecorationState = ReturnType<typeof buildDecorations> & { typingEnd: number | null };

const decorate = (text: string, context: ComposerLanguageContext, typingEnd: number | null): DecorationState => ({
    ...buildDecorations(text, context, typingEnd),
    typingEnd,
});

const decorationField = StateField.define<DecorationState>({
    create: (state) => decorate(state.doc.toString(), state.field(languageContextField), null),
    update(value, transaction) {
        const contextChanged = transaction.effects.some((effect) => effect.is(setLanguageContext));
        if (!transaction.docChanged && !contextChanged) return value;
        // A registry update mid-word keeps the word being typed as text.
        const typingEnd = transaction.docChanged
            ? typedChangeEnd(transaction)
            : value.typingEnd;
        return decorate(
            transaction.state.doc.toString(),
            transaction.state.field(languageContextField),
            typingEnd,
        );
    },
    provide: (field) => [
        EditorView.decorations.from(field, (value) => value.highlights),
        EditorView.decorations.from(field, (value) => value.chips),
        EditorView.atomicRanges.of((view) => view.state.field(field).chips),
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
