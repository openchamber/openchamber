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

export type ChatQuoteAnchor = {
    /** The quoted fragment exactly as it appears in the text stream. */
    text: string;
    /** Up to CONTEXT_LENGTH characters before and after the fragment. */
    prefix: string;
    suffix: string;
    /** Stream offset at capture time; a tie-breaker, not a position. */
    start: number;
};

export const chatQuoteAnchorSchema = z.object({
    text: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    start: z.number(),
});

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

/** Anchor for a quote sent before anchors existed: its text, found only if unique. */
export function legacyChatQuoteAnchor(quote: string): ChatQuoteAnchor {
    return { text: quote.trim(), prefix: '', suffix: '', start: 0 };
}
