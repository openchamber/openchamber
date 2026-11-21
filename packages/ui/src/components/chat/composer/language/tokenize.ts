
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

export type ComposerChipTarget =
    | { kind: 'attachment'; filename: string }
    | { kind: 'path'; path: string }
    | { kind: 'link'; url: string };

export interface ComposerLanguageContext {
    inputMode: 'normal' | 'shell';
    knownAgentNames: ReadonlySet<string>;
    confirmedMentions: ReadonlySet<string>;
    confirmedMentionsRevision?: number;
    mentionDismissal?: { dismiss: (name: string) => void; hint: string };
    knownSlashNames: ReadonlySet<string>;
    knownSnippetTriggers: ReadonlySet<string>;
    attachmentFilenames: readonly string[];
    pendingAttachmentFilenames?: ReadonlySet<string>;
    missingAttachments?: { names: readonly string[]; title: string };
    onChipOpen?: (target: ComposerChipTarget) => void;
    knownSkillNames?: ReadonlySet<string>;
    fileIconVariant?: 'light' | 'dark';
    sessionLinkChips?: ReadonlyMap<string, { label: string; title: string; iconHref: string }>;
    sessionLinkOrigins?: readonly string[];
    referenceLinkChips?: ReadonlyMap<string, { label: string; title: string; iconHref: string; openUrl?: string }>;
}

export function tokenizeMentions(
    text: string,
    context: Pick<ComposerLanguageContext, 'knownAgentNames' | 'confirmedMentions'>,
): MentionRange[] {
    const ranges: MentionRange[] = [];
    for (const token of scanMentions(text, context.confirmedMentions)) {
        const kind = classifyMention(token.name, context);
        if (kind) ranges.push({ start: token.start, end: token.end, kind });
    }
    return ranges;
}

export function tokenizeComposer(
    text: string,
    context: ComposerLanguageContext,
): HighlightRange[] {
    if (!text || context.inputMode === 'shell') return [];

    const ranges: HighlightRange[] = [
        ...tokenizeMarkdown(text),
        ...highlightFencedCode(text),
        ...mentionRangesToHighlightRanges(tokenizeMentions(text, context)),
        ...pathHighlightRanges(text),
    ];

    for (const token of filterKnownTokens(scanPrefixTokens(text, '/'), context.knownSlashNames)) {
        ranges.push({ start: token.start, end: token.end, style: 'mentionCommand' });
    }

    if (context.knownSkillNames) {
        for (const token of filterKnownTokens(scanPrefixTokens(text, '$'), context.knownSkillNames)) {
            ranges.push({ start: token.start, end: token.end, style: 'mentionCommand' });
        }
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
