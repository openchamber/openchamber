/**
 * Anchors a chat quote to the rendered text of the message it came from, so
 * the quoted fragment can be found again after the message re-renders, scrolls
 * out of the virtualized list and back, or the page reloads.
 *
 * Offsets count characters of the root's text stream: the concatenated data of
 * every descendant Text node in document order (what `textContent` and
 * `Range.toString()` both produce). An offset alone is not trusted; the quote
 * is re-found by its text, disambiguated by the characters around it.
 */

import { z } from 'zod';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import { defaultRemarkPlugins } from 'streamdown';
import type { Root, RootContent } from 'mdast';

export type ChatQuoteAnchor = {
    /** The quoted fragment exactly as it appears in the text stream. */
    text: string;
    /** Up to CONTEXT_LENGTH characters before and after the fragment. */
    prefix: string;
    suffix: string;
    /** Stream offset at capture time; a tie-breaker, not a position. */
    start: number;
    /**
     * Set when the text lives in a page the agent showed (`openchamber_render`)
     * instead of the message's own text: the stream is then that page's body,
     * measured and re-found inside its frame. Anchors without it are unchanged.
     */
    page?: { partId: string };
};

export const chatQuoteAnchorSchema = z.object({
    text: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    start: z.number(),
    page: z.object({ partId: z.string() }).optional(),
});

// The page bootstrap (message/parts/htmlRender.ts) repeats both numbers.
const CONTEXT_LENGTH = 32;
const MAX_OCCURRENCES = 200;

/**
 * The element whose text a quote is anchored in, inside `[data-message-id]`:
 * the message body that hosts the selection menu, so capture and lookup read
 * the same text.
 */
const CHAT_QUOTE_ROOT_SELECTOR = '[data-chat-quote-root]';

/**
 * The quote roots of a message that are mounted, in reading order. A long
 * answer is drawn in several transcript rows, each with its own root
 * (`data-message-slice`); their text streams, joined in order, are the
 * message's stream, as one root's was before it was cut.
 */
export function findChatQuoteRoots(scope: ParentNode, messageId: string): Element[] {
    return [...scope.querySelectorAll(`[data-message-id="${CSS.escape(messageId)}"]`)]
        .flatMap((message) => message.querySelector(CHAT_QUOTE_ROOT_SELECTOR) ?? [])
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
}

// The anchor's context around `index`, as far as `stream` reaches: a row of
// a long answer that is not mounted leaves the stream short of it.
function hasContextAt(stream: string, anchor: ChatQuoteAnchor, index: number): boolean {
    const end = index + anchor.text.length;
    const before = stream.slice(Math.max(0, index - anchor.prefix.length), index);
    const after = stream.slice(end, end + anchor.suffix.length);
    return anchor.prefix.endsWith(before) && anchor.suffix.startsWith(after);
}

/** Stream offset of a boundary point inside `root`. */
function streamOffset(root: Node, container: Node, offset: number): number {
    const probe = root.ownerDocument!.createRange();
    probe.setStart(root, 0);
    probe.setEnd(container, offset);
    return probe.toString().length;
}

/** The joined stream of `roots`, and where each root's part of it starts. */
function joinStreams(roots: readonly Element[]) {
    const bases: number[] = [];
    let stream = '';
    for (const root of roots) {
        bases.push(stream.length);
        stream += root.textContent ?? '';
    }
    return { stream, bases };
}

/** An anchor for `range` in the stream of `roots` (one message's roots, in order). */
export function captureChatQuoteAnchor(roots: Element | readonly Element[], range: Range): ChatQuoteAnchor | null {
    const list = Array.isArray(roots) ? roots : [roots];
    const startIndex = list.findIndex((root) => root.contains(range.startContainer));
    const endIndex = list.findIndex((root) => root.contains(range.endContainer));
    if (startIndex < 0 || endIndex < startIndex) return null;
    const { stream, bases } = joinStreams(list);
    const start = bases[startIndex] + streamOffset(list[startIndex], range.startContainer, range.startOffset);
    const end = bases[endIndex] + streamOffset(list[endIndex], range.endContainer, range.endOffset);
    const text = stream.slice(start, end);
    if (!text.trim()) return null;
    return {
        text,
        prefix: stream.slice(Math.max(0, start - CONTEXT_LENGTH), start),
        suffix: stream.slice(end, end + CONTEXT_LENGTH),
        start,
    };
}

/**
 * Where the anchor's text sits in `stream`, or null when it is gone or cannot
 * be told apart from other copies of the same text.
 */
export function locateChatQuote(stream: string, anchor: ChatQuoteAnchor): number | null {
    if (!anchor.text) return null;
    const occurrences: number[] = [];
    for (let index = stream.indexOf(anchor.text); index !== -1 && occurrences.length < MAX_OCCURRENCES; index = stream.indexOf(anchor.text, index + 1)) {
        occurrences.push(index);
    }
    if (occurrences.length <= 1) return occurrences[0] ?? null;
    // Without surrounding text (quotes sent before anchors existed) copies
    // cannot be told apart; highlighting a guess would point at the wrong one.
    if (!anchor.prefix && !anchor.suffix) return null;

    const inContext = occurrences.filter((index) => hasContextAt(stream, anchor, index));
    if (inContext.length === 0) return null;
    return inContext.reduce((best, index) => (
        Math.abs(index - anchor.start) < Math.abs(best - anchor.start) ? index : best
    ));
}

function collectTextNodes(node: Node, into: Text[]): Text[] {
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
            // SAFETY: nodeType 3 is TEXT_NODE.
            into.push(child as Text);
        } else {
            collectTextNodes(child, into);
        }
    }
    return into;
}

/**
 * Whether `roots` hold the whole message: every row of a long answer is
 * mounted (`data-message-row` is `index/count` on each row's message element).
 */
function isWholeMessage(roots: readonly Element[]): boolean {
    const rows = new Set<string>();
    let count = 1;
    for (const root of roots) {
        const row = root.closest('[data-message-id]')?.getAttribute('data-message-row');
        if (!row) return roots.length === 1;
        const [index, total] = row.split('/');
        rows.add(index);
        count = Number(total);
    }
    return rows.size === count;
}

// The shortest stretch of a quote's text taken as its start or end on screen.
const PARTIAL_MATCH_LENGTH = 32;

/**
 * Where the anchored text sits in the stream of part of a message (rows of a
 * long answer above or below are not mounted), clipped to it: the whole
 * quote, its start running past the stream's end, its end coming in at the
 * stream's start, or a stream that lies inside the quote. Context is required,
 * as far as the stream reaches: a lone copy here may not be the only one in
 * the message.
 */
function locateInPartialStream(stream: string, anchor: ChatQuoteAnchor): { start: number; end: number } | null {
    const { text, prefix, suffix } = anchor;
    // A quote sent before anchors existed has no context to check: what it
    // matches is taken only when it is the one match on the page, as the
    // whole message's only copy was.
    const hasContext = Boolean(prefix || suffix);
    const occurrencesOf = (needle: string): number[] => {
        const found: number[] = [];
        for (let index = stream.indexOf(needle); index !== -1 && found.length < MAX_OCCURRENCES; index = stream.indexOf(needle, index + 1)) found.push(index);
        return found;
    };
    const candidates: Array<{ start: number; end: number }> = [];
    for (const index of occurrencesOf(text)) {
        if (!hasContext || hasContextAt(stream, anchor, index)) candidates.push({ start: index, end: index + text.length });
    }
    if (text.length > PARTIAL_MATCH_LENGTH && (candidates.length === 0 || !hasContext)) {
        for (const index of occurrencesOf(text.slice(0, PARTIAL_MATCH_LENGTH))) {
            const rest = stream.slice(index);
            if (rest.length < text.length && text.startsWith(rest)
                && prefix.endsWith(stream.slice(Math.max(0, index - prefix.length), index))) {
                candidates.push({ start: index, end: stream.length });
            }
        }
        for (const index of occurrencesOf(text.slice(-PARTIAL_MATCH_LENGTH))) {
            const end = index + PARTIAL_MATCH_LENGTH;
            if (end < text.length && text.endsWith(stream.slice(0, end))
                && suffix.startsWith(stream.slice(end, end + suffix.length))) {
                candidates.push({ start: 0, end });
            }
        }
        if (stream.length >= PARTIAL_MATCH_LENGTH && stream.length < text.length && text.includes(stream)) {
            candidates.push({ start: 0, end: stream.length });
        }
    }
    if (hasContext) return candidates[0] ?? null;
    // One stretch can match two ways (a stream that is the quote's start also lies inside it).
    const distinct = new Set(candidates.map((candidate) => `${candidate.start}:${candidate.end}`));
    return distinct.size === 1 ? candidates[0] : null;
}

/**
 * Live Ranges over the anchored fragment in the stream of `roots` (one
 * message's roots, in order), one per root it crosses; null when not found.
 * When rows of the message are not mounted, the part of the quote they hold
 * is left out: the Ranges cover what is on the page.
 */
export function resolveChatQuoteRanges(roots: readonly Element[], anchor: ChatQuoteAnchor): Range[] | null {
    const { stream } = joinStreams(roots);
    let start: number | null;
    let end: number;
    if (isWholeMessage(roots)) {
        start = locateChatQuote(stream, anchor);
        end = (start ?? 0) + anchor.text.length;
    } else {
        const span = locateInPartialStream(stream, anchor);
        start = span?.start ?? null;
        end = span?.end ?? 0;
    }
    if (start === null || end <= start) return null;

    const ranges: Range[] = [];
    let offset = 0;
    for (const root of roots) {
        let range: Range | null = null;
        for (const node of collectTextNodes(root, [])) {
            const length = node.data.length;
            if (!range && start < offset + length && end > offset) {
                range = root.ownerDocument.createRange();
                range.setStart(node, Math.max(0, start - offset));
                range.setEnd(root, root.childNodes.length);
            }
            if (range && end <= offset + length) {
                range.setEnd(node, end - offset);
                ranges.push(range);
                return ranges;
            }
            offset += length;
        }
        if (range) ranges.push(range);
    }
    return null;
}

/** A live Range over the anchored fragment in `root`, or null when not found. */
export function resolveChatQuoteAnchor(root: Element, anchor: ChatQuoteAnchor): Range | null {
    return resolveChatQuoteRanges([root], anchor)?.[0] ?? null;
}

// Streamdown 2.7.1 exports GFM as a plugin/options tuple, typed as Pluggable.
const gfmEntry = defaultRemarkPlugins.gfm as [Plugin<[{ singleTilde?: boolean }?], Root>, Record<string, unknown>];
const legacyQuoteParser = unified().use(remarkParse).use(gfmEntry[0], { singleTilde: false });

/** Anchor for a quote sent before anchors existed: its text, found only if unique. */
export function legacyChatQuoteAnchor(quote: string): ChatQuoteAnchor {
    const text = (node: Root | RootContent): string => {
        if ('children' in node) {
            // Streamdown renders compact list items and keeps the structural
            // newlines around lists, including a trailing nested list.
            if (node.type === 'list') {
                return `\n${node.children.map(text).join('\n')}\n`;
            }
            if (node.type === 'listItem') {
                const body = node.children.map((child) => text(child)).join('\n');
                return node.children.at(-1)?.type === 'paragraph' ? body : `${body}\n`;
            }
            const separator = node.type === 'root' || node.type === 'blockquote' ? '\n' : '';
            const body = node.children.map((child) => text(child)).join(separator);
            return node.type === 'blockquote' ? `\n${body}\n` : body;
        }
        switch (node.type) {
            case 'break':
                return '\n';
            case 'code':
                // The renderer's header is part of the DOM text stream too.
                return `${node.lang?.toLowerCase() || 'text'}${node.value}`;
            case 'text':
            case 'inlineCode':
            case 'html':
                return node.value;
            default:
                return '';
        }
    };
    return { text: text(legacyQuoteParser.parse(quote.trim())).trim(), prefix: '', suffix: '', start: 0 };
}
