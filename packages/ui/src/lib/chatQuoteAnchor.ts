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

export function findChatQuoteRoot(scope: ParentNode, messageId: string): Element | null {
    const message = scope.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    return message?.querySelector(CHAT_QUOTE_ROOT_SELECTOR) ?? null;
}

/** Stream offset of a boundary point inside `root`. */
function streamOffset(root: Node, container: Node, offset: number): number {
    const probe = root.ownerDocument!.createRange();
    probe.setStart(root, 0);
    probe.setEnd(container, offset);
    return probe.toString().length;
}

export function captureChatQuoteAnchor(root: Element, range: Range): ChatQuoteAnchor | null {
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const stream = root.textContent ?? '';
    const start = streamOffset(root, range.startContainer, range.startOffset);
    const end = streamOffset(root, range.endContainer, range.endOffset);
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

    const inContext = occurrences.filter((index) => (
        index >= anchor.prefix.length
        && stream.startsWith(anchor.prefix, index - anchor.prefix.length)
        && stream.startsWith(anchor.suffix, index + anchor.text.length)
    ));
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

/** A live Range over the anchored fragment in `root`, or null when not found. */
export function resolveChatQuoteAnchor(root: Element, anchor: ChatQuoteAnchor): Range | null {
    const start = locateChatQuote(root.textContent ?? '', anchor);
    if (start === null) return null;
    const end = start + anchor.text.length;

    const range = root.ownerDocument.createRange();
    let offset = 0;
    let startSet = false;
    for (const node of collectTextNodes(root, [])) {
        const length = node.data.length;
        if (!startSet && start < offset + length) {
            range.setStart(node, start - offset);
            startSet = true;
        }
        if (startSet && end <= offset + length) {
            range.setEnd(node, end - offset);
            return range;
        }
        offset += length;
    }
    return null;
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
