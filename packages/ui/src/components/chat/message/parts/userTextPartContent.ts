import type { AgentMentionInfo } from '../types';
import {
    buildAgentHref,
    buildAttachmentHref,
    buildSkillHref,
    type AttachmentCitationLink,
} from '@/lib/messages/inlineMessageLinks';
import { findAttachmentCitationRanges } from '../../attachmentCitations';

// Skills are named with `$`; messages sent before that used `/`, which history
// still shows as a chip.
export const SKILL_TOKEN_PATTERN = /(^|\s)[$/]([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

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
        output += `[${escapeMarkdownLinkText(escapeHtml(attachment.filename))}](${buildAttachmentHref(attachment)})`;
        cursor = range.end;
    }
    return output + escapeHtml(segment.slice(cursor));
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
}: {
    textContent: string;
    agentMention?: AgentMentionInfo;
    skillNames: ReadonlySet<string>;
    attachments?: ReadonlyArray<AttachmentCitationLink>;
}): string => {
    const loneListMarker = LONE_LIST_MARKER_PATTERN.exec(textContent);
    if (loneListMarker) return `\\${loneListMarker[1]}`;

    let content = mapNonFencedSegments(textContent, (segment) => escapeWithAttachmentCitations(segment, attachments));

    // Insert agent mention links with an internal href so markdown renders them as mentions, not external links.
    if (agentMention?.token && content.includes(agentMention.token)) {
        const mentionMarkdown = `[${agentMention.token}](${buildAgentHref(agentMention.name)})`;
        content = content.replace(agentMention.token, mentionMarkdown);
    }

    content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
        if (!skillNames.has(skillName)) return match;
        return `${prefix}[/${skillName}](${buildSkillHref(skillName)})`;
    });

    // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
    return applyHardLineBreaks(content);
};
