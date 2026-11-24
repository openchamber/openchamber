
import { RangeSetBuilder, StateEffect, StateField, type Transaction } from '@codemirror/state';
import { Decoration, Direction, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { CHIP_TRAILING_PUNCTUATION, INLINE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS, SKILL_CHIP_ICON_HREF } from '@/lib/messages/inlineMessageLinks';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import { findAttachmentCitationRanges, findLocalFileLinks } from '../../attachmentCitations';
import { resolveHighlightSegments, DEFAULT_HIGHLIGHT_CLASS, type HighlightRange } from '../../composerHighlight';
import { findSessionLinks, sessionLinkKey } from '@/lib/sessionLinks';
import { findWebLinks } from '../referenceLinks';
import { filterKnownTokens, scanPrefixTokens } from '../language/prefixTokens';
import { tokenizeComposer, tokenizeMentions, type ComposerLanguageContext } from '../language/tokenize';

export const setLanguageContext = StateEffect.define<ComposerLanguageContext>();

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

const DISMISS_NAME_KEY = 'mentionName';
const OPEN_TARGET_KEY = 'chipOpen';

class ReferenceChipWidget extends WidgetType {
    constructor(
        readonly label: string,
        readonly title: string,
        readonly iconHref: string,
        readonly options: {
            dismissName?: string;
            unavailable?: boolean;
            openTarget?: string;
        } = {},
    ) {
        super();
    }

    get dismissName() { return this.options.dismissName; }
    get unavailable() { return this.options.unavailable === true; }
    get openTarget() { return this.options.openTarget; }

    eq(other: ReferenceChipWidget): boolean {
        return other.label === this.label && other.title === this.title && other.iconHref === this.iconHref
            && other.dismissName === this.dismissName && other.unavailable === this.unavailable
            && other.openTarget === this.openTarget;
    }

    toDOM(view: EditorView): HTMLElement {
        const doc = view.dom.ownerDocument;
        const chip = doc.createElement('span');
        chip.className = this.unavailable
            ? `${INLINE_REFERENCE_CHIP_CLASS.replace('text-foreground', 'text-muted-foreground')} border-dashed`
            : INLINE_REFERENCE_CHIP_CLASS;
        chip.style.maxWidth = 'min(18rem, calc(100% - 2ch))';
        if (this.dismissName !== undefined) chip.dataset[DISMISS_NAME_KEY] = this.dismissName;
        if (this.openTarget !== undefined) {
            chip.dataset[OPEN_TARGET_KEY] = this.openTarget;
            chip.style.cursor = 'pointer';
        }
        chip.title = this.title;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'block size-[1.1em] shrink-0');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', this.iconHref);
        svg.appendChild(use);
        const label = doc.createElement('span');
        label.className = REFERENCE_CHIP_LABEL_CLASS;
        label.textContent = this.label;
        chip.append(svg, label);
        return chip;
    }

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

type ReferenceChipDecorations = { chips: DecorationSet; glue: DecorationSet };

function referenceChips(text: string, context: ComposerLanguageContext, typingEnd: number | null): ReferenceChipDecorations {
    if (context.inputMode === 'shell' || !text) return { chips: Decoration.none, glue: Decoration.none };
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
                widget: new ReferenceChipWidget(filename, filename, getFileTypeIconHref(filename, { themeVariant }), { openTarget: `attachment:${filename}` }),
            });
        }
    }
    const missing = context.missingAttachments;
    if (missing && missing.names.length > 0 && text.includes('[')) {
        for (const range of findAttachmentCitationRanges(text, [...missing.names])) {
            const filename = text.slice(range.start + 1, range.end - 1).trim();
            chips.push({
                ...range,
                widget: new ReferenceChipWidget(filename, `${filename}\n${missing.title}`, getFileTypeIconHref(filename, { themeVariant }), { unavailable: true }),
            });
        }
    }
    if (text.includes('](')) {
        for (const link of findLocalFileLinks(text)) {
            chips.push({
                start: link.start,
                end: link.end,
                widget: new ReferenceChipWidget(link.name, link.path, getFileTypeIconHref(link.name, { themeVariant }), { openTarget: `path:${link.path}` }),
            });
        }
    }

    if (text.includes('@')) {
        const hint = context.mentionDismissal?.hint;
        const titleOf = (name: string) => (hint ? `@${name}\n${hint}` : `@${name}`);
        const dismissable = (name: string) => (context.mentionDismissal ? name : undefined);
        for (const mention of tokenizeMentions(text, context)) {
            const name = text.slice(mention.start + 1, mention.end);
            if (mention.kind === 'agent') {
                addToken(mention.start, mention.end, new ReferenceChipWidget(name, titleOf(name), AGENT_CHIP_ICON_HREF, { dismissName: dismissable(name.toLowerCase()) }));
                continue;
            }
            const iconHref = /[\\/]$/.test(name) ? FOLDER_CHIP_ICON_HREF : getFileTypeIconHref(name, { themeVariant });
            addToken(mention.start, mention.end, new ReferenceChipWidget(basename(name), titleOf(name), iconHref, { dismissName: dismissable(name) }));
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

    if (context.sessionLinkChips?.size) {
        for (const range of findSessionLinks(text, context.sessionLinkOrigins ?? [])) {
            const chip = context.sessionLinkChips.get(sessionLinkKey(range.target));
            if (chip) chips.push({ start: range.start, end: range.end, widget: new ReferenceChipWidget(chip.label, chip.title, chip.iconHref) });
        }
    }

    if (context.referenceLinkChips?.size) {
        for (const range of findWebLinks(text)) {
            const chip = context.referenceLinkChips.get(range.link);
            if (chip) chips.push({ start: range.start, end: range.end, widget: new ReferenceChipWidget(chip.label, chip.title, chip.iconHref, { openTarget: `link:${chip.openUrl ?? range.link}` }) });
        }
    }

    chips.sort((a, b) => a.start - b.start);
    const builder = new RangeSetBuilder<Decoration>();
    const glue = new RangeSetBuilder<Decoration>();
    let lastEnd = -1;
    for (const chip of chips) {
        if (chip.start < lastEnd) continue;
        builder.add(chip.start, chip.end, Decoration.replace({ widget: chip.widget }));
        lastEnd = chip.end;
        const trailing = CHIP_TRAILING_PUNCTUATION.exec(text.slice(chip.end, chip.end + 8))?.[0];
        if (trailing) glue.add(chip.start, chip.end + trailing.length, chipGlue);
    }
    return { chips: builder.finish(), glue: glue.finish() };
}

const chipGlue = Decoration.mark({ attributes: { style: 'white-space: nowrap' } });

function buildDecorations(text: string, context: ComposerLanguageContext, typingEnd: number | null = null) {
    const ranges = tokenizeComposer(text, context);
    const builder = new RangeSetBuilder<Decoration>();
    for (const segment of resolveHighlightSegments(text, ranges)) {
        if (segment.className === DEFAULT_HIGHLIGHT_CLASS) continue;
        builder.add(segment.start, segment.end, Decoration.mark({ class: segment.className }));
    }
    return {
        highlights: builder.finish(),
        ...referenceChips(text, context, typingEnd),
        isolates: context.inputMode === 'shell' && text.length > 0
            ? Decoration.set([ltrIsolate.range(0, text.length)])
            : technicalIsolates(ranges),
    };
}

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
        EditorView.outerDecorations.from(field, (value) => value.glue),
        EditorView.bidiIsolatedRanges.from(field, (value) => value.isolates),
    ],
});

const mentionChipDismissal = EditorView.domEventHandlers({
    dblclick(event, view) {
        const context = view.state.field(languageContextField);
        const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-mention-name]') : null;
        const name = chip?.dataset[DISMISS_NAME_KEY];
        if (!context.mentionDismissal || !chip || name === undefined) return false;

        const start = view.posAtDOM(chip);
        let end: number | null = null;
        view.state.field(decorationField).chips.between(start, start, (from, to) => {
            if (from === start) end = to;
        });
        if (end === null) return false;

        context.mentionDismissal.dismiss(name);
        view.dispatch({ selection: { anchor: end }, effects: setLanguageContext.of(context) });
        view.focus();
        event.preventDefault();
        return true;
    },
});

const chipOpening = EditorView.domEventHandlers({
    click(event, view) {
        const context = view.state.field(languageContextField);
        const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-chip-open]') : null;
        const target = chip?.dataset[OPEN_TARGET_KEY];
        if (!context.onChipOpen || !target || event.detail > 1) return false;
        const separator = target.indexOf(':');
        const kind = target.slice(0, separator);
        const value = target.slice(separator + 1);
        if (kind === 'attachment') context.onChipOpen({ kind, filename: value });
        else if (kind === 'path') context.onChipOpen({ kind, path: value });
        else if (kind === 'link') context.onChipOpen({ kind, url: value });
        else return false;
        return true;
    },
});

export function composerLanguage(initial: ComposerLanguageContext = EMPTY_CONTEXT) {
    return [
        languageContextField.init(() => initial),
        decorationField,
        mentionChipDismissal,
        chipOpening,
    ];
}
