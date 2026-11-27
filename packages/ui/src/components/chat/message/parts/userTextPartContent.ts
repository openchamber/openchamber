import type { Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { defaultRemarkPlugins } from 'streamdown';
import { unified } from 'unified';
import type { AgentMentionInfo } from '../types';
import { markdownMath, remarkLiteralText } from '../../markdown/streamdownPlugins';
import {
    CHIP_TRAILING_PUNCTUATION,
    buildAgentHref,
    buildAttachmentHref,
    buildSkillHref,
    type AttachmentCitationLink,
} from '@/lib/messages/inlineMessageLinks';
import { findSessionLinks, sessionLinkKey } from '@/lib/sessionLinks';
import { findAttachmentCitationRanges } from '../../attachmentCitations';
import { resolveKnownName } from '../../composer/language/prefixTokens';
import type { SessionMentionChips } from './sessionMentionChips';

export const SKILL_TOKEN_PATTERN = /(^|\s)[$/¥￥＄]([A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const mapNonFencedSegments = (markdown: string, mapSegment: (segment: string) => string): string => {
    return markdown
        .split(FENCED_CODE_SEGMENT_PATTERN)
        .map((segment, index) => (index % 2 === 1 ? segment : mapSegment(segment)))
        .join('');
};

const escapeMarkdownLinkText = (text: string): string => text.replace(/[\\`*_~[\]]/g, '\\$&');

const joinTrailing = (text: string, at: number): string => (CHIP_TRAILING_PUNCTUATION.test(text.slice(at, at + 8)) ? '\u2060' : '');

const withAttachmentCitations = (
    segment: string,
    attachments: ReadonlyArray<AttachmentCitationLink>,
): string => {
    if (attachments.length === 0) return segment;
    const byName = new Map(attachments.map((attachment) => [attachment.filename.trim().toLowerCase(), attachment]));
    let output = '';
    let cursor = 0;
    for (const range of findAttachmentCitationRanges(segment, [...byName.keys()])) {
        const attachment = byName.get(segment.slice(range.start + 1, range.end - 1).trim().toLowerCase());
        if (!attachment) continue;
        output += segment.slice(cursor, range.start);
        output += `[${escapeMarkdownLinkText(attachment.filename)}](${buildAttachmentHref(attachment)})${joinTrailing(segment, range.end)}`;
        cursor = range.end;
    }
    return output + segment.slice(cursor);
};

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
        if (segment.slice(Math.max(0, range.start - 2), range.start) === '](' || segment[range.start - 1] === '<') continue;
        if (codeSpans.some(([start, end]) => range.start >= start && range.start < end)) continue;
        output += escapeRest(segment.slice(cursor, range.start));
        const destination = range.link.replace(/[\\<>]/g, (char) => encodeURIComponent(char));
        output += `[${escapeMarkdownLinkText(chip.label)}](<${destination}>)${joinTrailing(segment, range.end)}`;
        cursor = range.end;
    }
    return output + escapeRest(segment.slice(cursor));
};

// external: https://spec.commonmark.org/0.31.2/#soft-line-breaks Preserve user newlines outside fenced code as hard breaks.
const applyHardLineBreaks = (markdown: string): string => {
    return mapNonFencedSegments(markdown, (segment) => segment.replace(/ *\n/g, '  \n'));
};

const LONE_LIST_MARKER_PATTERN = /^\s*([+*-])\s*$/;

const literalSourceParser = unified().use(remarkParse).use(remarkLiteralText).use([defaultRemarkPlugins.gfm, markdownMath.remarkPlugin]);
const LITERAL_SOURCE_NODES: ReadonlySet<string> = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'image', 'definition']);

const literalSourceRanges = (markdown: string): Array<[number, number]> => {
    const ranges: Array<[number, number]> = [];
    const walk = (node: Root | RootContent): void => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        if (LITERAL_SOURCE_NODES.has(node.type) || (node.type === 'link' && markdown[start] !== '[')) {
            ranges.push([start, end]);
            return;
        }
        if ('children' in node) node.children.forEach(walk);
        if (node.type === 'link') ranges.push([node.children.at(-1)?.position?.end.offset ?? start + 1, end]);
    };
    walk(literalSourceParser.parse(markdown));
    return ranges;
};

const doubleBackslashRuns = (text: string): string => text.replace(/\\+(?=[.?])/g, (run) => run + run);

// external: https://spec.commonmark.org/0.31.2/#backslash-escapes Double prose backslashes only before dot and question mark; preserve code, math and intentional escapes.
const escapeBackslashesBeforePunctuation = (text: string): string => {
    if (!/\\[.?]/.test(text)) return text;
    let output = '';
    let cursor = 0;
    for (const [start, end] of literalSourceRanges(text)) {
        output += doubleBackslashRuns(text.slice(cursor, start)) + text.slice(start, end);
        cursor = end;
    }
    return output + doubleBackslashRuns(text.slice(cursor));
};

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
    sessionMentions?: { chips: SessionMentionChips; origins: readonly string[] };
}): string => {
    const loneListMarker = LONE_LIST_MARKER_PATTERN.exec(textContent);
    if (loneListMarker) return `\\${loneListMarker[1]}`;

    let content = mapNonFencedSegments(escapeBackslashesBeforePunctuation(textContent), (segment) => withSessionMentionLinks(
        segment,
        sessionMentions,
        (rest) => withAttachmentCitations(rest, attachments),
    ));

    if (agentMention?.token && content.includes(agentMention.token)) {
        const mentionMarkdown = `[${agentMention.token}](${buildAgentHref(agentMention.name)})`;
        content = content.replace(agentMention.token, mentionMarkdown);
    }

    content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, scanned: string, offset: number, whole: string) => {
        const skillName = resolveKnownName(scanned, (name) => skillNames.has(name));
        if (!skillName) return match;
        const rest = scanned.slice(skillName.length);
        const trailing = rest ? joinTrailing(rest, 0) + rest : joinTrailing(whole, offset + match.length);
        return `${prefix}[/${skillName}](${buildSkillHref(skillName)})${trailing}`;
    });

    return applyHardLineBreaks(content);
};
