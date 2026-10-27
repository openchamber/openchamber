import type { AgentMentionInfo } from '../types';
import {
    CHIP_TRAILING_PUNCTUATION,
    buildAgentHref,
    buildAttachmentHref,
    buildSkillHref,
    type AttachmentCitationLink,
} from '@/lib/messages/inlineMessageLinks';
import { findSessionLinks, sessionLinkKey } from '@/lib/sessionLinks';
import { findAttachmentCitationRanges } from '../../attachmentCitations';
import type { SessionMentionChips } from './sessionMentionChips';

// Skills are named with `$`; messages sent before that used `/`, which history
// still shows as a chip. A CJK IME types `¥`, `￥` or `＄` for the same key, so
// a hand-typed token can arrive with any of those spellings.
export const SKILL_TOKEN_PATTERN = /(^|\s)[$/¥￥＄]([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const escapeHtml = (text: string): string => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
};

const mapNonFencedSegments = (markdown: string, mapSegment: (segment: string) => string): string => {
    return markdown
        .split(FENCED_CODE_SEGMENT_PATTERN)
        .map((segment, index) => (index % 2 === 1 ? segment : mapSegment(segment)))
        .join('');
};

const escapeMarkdownLinkText = (text: string): string => text.replace(/[\\`*_~[\]]/g, '\\$&');

// A word joiner after a chip's link when punctuation follows, so the line
// never breaks between the chip and its comma (`CHIP_TRAILING_PUNCTUATION`).
const joinTrailing = (text: string, at: number): string => (CHIP_TRAILING_PUNCTUATION.test(text.slice(at, at + 8)) ? '\u2060' : '');

/**
 * Escapes a non-code segment and turns each `[name.png]` citation of one of
 * the message's own attachments into an attachment link, which the Markdown
 * renderer draws as a file chip. Brackets around anything else stay text.
 */
const escapeWithAttachmentCitations = (
    segment: string,
    attachments: ReadonlyArray<AttachmentCitationLink>,
): string => {
    if (attachments.length === 0) return escapeHtml(segment);
    const byName = new Map(attachments.map((attachment) => [attachment.filename.trim().toLowerCase(), attachment]));
    let output = '';
    let cursor = 0;
    for (const range of findAttachmentCitationRanges(segment, [...byName.keys()])) {
        const attachment = byName.get(segment.slice(range.start + 1, range.end - 1).trim().toLowerCase());
        if (!attachment) continue;
        output += escapeHtml(segment.slice(cursor, range.start));
        output += `[${escapeMarkdownLinkText(escapeHtml(attachment.filename))}](${buildAttachmentHref(attachment)})${joinTrailing(segment, range.end)}`;
        cursor = range.end;
    }
    return output + escapeHtml(segment.slice(cursor));
};

/**
 * Turns each session or message link the message mentioned into a link
 * labelled with its chip text, which the Markdown renderer draws as the chip
 * (`SessionMentionChipsContext`); everything else goes on to `escapeRest`.
 */
const withSessionMentionLinks = (
    segment: string,
    mentions: { chips: SessionMentionChips; origins: readonly string[] } | undefined,
    escapeRest: (text: string) => string,
): string => {
    if (!mentions || mentions.chips.size === 0) return escapeRest(segment);
    const codeSpans = [...segment.matchAll(/(`+)[\s\S]*?\1/g)].map((match) => [match.index, match.index + match[0].length]);
    let output = '';
    let cursor = 0;
    for (const range of findSessionLinks(segment, mentions.origins)) {
        const chip = mentions.chips.get(sessionLinkKey(range.target));
        if (!chip) continue;
        // A link the user already wrote as one (`[this](link)`, `<link>`) draws as
        // the chip on its own (`MarkdownLink`); one in inline code stays code.
        if (segment.slice(Math.max(0, range.start - 2), range.start) === '](' || segment[range.start - 1] === '<') continue;
        if (codeSpans.some(([start, end]) => range.start >= start && range.start < end)) continue;
        output += escapeRest(segment.slice(cursor, range.start));
        // Escaped so the pointy destination cannot be closed or broken from inside.
        const destination = range.link.replace(/[\\<>]/g, (char) => encodeURIComponent(char));
        output += `[${escapeMarkdownLinkText(escapeHtml(chip.label))}](<${destination}>)${joinTrailing(segment, range.end)}`;
        cursor = range.end;
    }
    return output + escapeRest(segment.slice(cursor));
};

// In Markdown a single "\n" is a soft break (rendered as a space). Users type plain
// text where each newline is meant literally, so convert soft breaks into hard breaks
// (two trailing spaces) outside of fenced code blocks, where newlines are already literal.
const applyHardLineBreaks = (markdown: string): string => {
    return mapNonFencedSegments(markdown, (segment) => segment.replace(/ *\n/g, '  \n'));
};

// A message that is only "+", "-" or "*" parses as an empty list item, which shows
// a bare marker dot instead of the sign the user typed.
const LONE_LIST_MARKER_PATTERN = /^\s*([+*-])\s*$/;

export const prepareUserMarkdownContent = ({
    textContent,
    agentMention,
    skillNames,
    attachments = [],
    sessionMentions,
}: {
    textContent: string;
    agentMention?: AgentMentionInfo;
    skillNames: ReadonlySet<string>;
    attachments?: ReadonlyArray<AttachmentCitationLink>;
    /** The message's mentioned sessions and messages, and this instance's web addresses their links point at. */
    sessionMentions?: { chips: SessionMentionChips; origins: readonly string[] };
}): string => {
    const loneListMarker = LONE_LIST_MARKER_PATTERN.exec(textContent);
    if (loneListMarker) return `\\${loneListMarker[1]}`;

    let content = mapNonFencedSegments(textContent, (segment) => withSessionMentionLinks(
        segment,
        sessionMentions,
        (rest) => escapeWithAttachmentCitations(rest, attachments),
    ));

    // Insert agent mention links with an internal href so markdown renders them as mentions, not external links.
    if (agentMention?.token && content.includes(agentMention.token)) {
        const mentionMarkdown = `[${agentMention.token}](${buildAgentHref(agentMention.name)})`;
        content = content.replace(agentMention.token, mentionMarkdown);
    }

    content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string, offset: number, whole: string) => {
        if (!skillNames.has(skillName)) return match;
        return `${prefix}[/${skillName}](${buildSkillHref(skillName)})${joinTrailing(whole, offset + match.length)}`;
    });

    // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
    return applyHardLineBreaks(content);
};
