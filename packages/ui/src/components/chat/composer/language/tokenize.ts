/**
 * One pass over the composer text producing every highlight range.
 *
 * The composer used to derive its highlighting from six independent memos in
 * ChatInput.tsx — markdown, fenced-code syntax, mentions, slash tokens,
 * snippet tokens and attachment citations — each re-scanning the same string
 * and each having to be remembered when a new construct was added. This is the
 * single entry point: give it the text and what the composer knows about the
 * workspace, get back the ranges.
 *
 * It is also the seam the editor renders through. The mirror overlay consumes
 * these ranges via `buildHighlightParts`; a CodeMirror view maps the same
 * ranges to decorations. Adding a construct to the language means adding it
 * here, once.
 */

import { findAttachmentCitationRanges } from '../../attachmentCitations';
import { highlightFencedCode } from '../../composerCodeHighlight';
import {
    mentionRangesToHighlightRanges,
    tokenizeMarkdown,
    type HighlightRange,
    type MentionRange,
} from '../../composerHighlight';
import { classifyMention, scanMentions } from './mentions';
import { pathHighlightRanges } from './paths';
import { filterKnownTokens, scanPrefixTokens } from './prefixTokens';

/**
 * What the composer knows about its workspace while tokenizing. Every set is
 * authoritative: a token is only a reference if it resolves against one of
 * them, so unknown `/tokens` and `@words` stay plain prose.
 */
export interface ComposerLanguageContext {
    /** Shell mode (`!cmd`) is not the prompt language — nothing is tokenized. */
    inputMode: 'normal' | 'shell';
    /** Lowercased names of the agents that can be mentioned. */
    knownAgentNames: ReadonlySet<string>;
    /** Mention paths confirmed by the picker, a drop, or a restored draft. */
    confirmedMentions: ReadonlySet<string>;
    /** Lowercased command, skill and built-in names invocable with `/`. */
    knownSlashNames: ReadonlySet<string>;
    /** Lowercased snippet names and aliases invocable with `#`. */
    knownSnippetTriggers: ReadonlySet<string>;
    /** Filenames of the currently attached files, cited inline as `[name]`. */
    attachmentFilenames: readonly string[];
}

/** Mention ranges alone — the composer also needs these to resolve references. */
export function tokenizeMentions(
    text: string,
    context: Pick<ComposerLanguageContext, 'knownAgentNames' | 'confirmedMentions'>,
): MentionRange[] {
    const ranges: MentionRange[] = [];
    for (const token of scanMentions(text)) {
        const kind = classifyMention(token.name, context);
        if (kind) ranges.push({ start: token.start, end: token.end, kind });
    }
    return ranges;
}

/**
 * Every highlight range in `text`. Ranges may overlap; `buildHighlightParts`
 * resolves them by priority.
 */
export function tokenizeComposer(
    text: string,
    context: ComposerLanguageContext,
): HighlightRange[] {
    if (!text || context.inputMode === 'shell') return [];

    const ranges: HighlightRange[] = [
        ...tokenizeMarkdown(text),
        ...highlightFencedCode(text),
        ...mentionRangesToHighlightRanges(tokenizeMentions(text, context)),
        // `~path` is inert: highlighted for the reader, never attached.
        ...pathHighlightRanges(text),
    ];

    for (const token of filterKnownTokens(scanPrefixTokens(text, '/'), context.knownSlashNames)) {
        ranges.push({ start: token.start, end: token.end, style: 'mentionCommand' });
    }

    for (const token of filterKnownTokens(scanPrefixTokens(text, '#'), context.knownSnippetTriggers)) {
        ranges.push({ start: token.start, end: token.end, style: 'mentionSnippet' });
    }

    if (context.attachmentFilenames.length > 0 && text.includes('[')) {
        for (const range of findAttachmentCitationRanges(text, [...context.attachmentFilenames])) {
            ranges.push({ ...range, style: 'mentionFile' });
        }
    }

    return ranges;
}
