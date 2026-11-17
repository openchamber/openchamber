
import { z } from 'zod';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import { defaultRemarkPlugins } from 'streamdown';
import type { Root, RootContent } from 'mdast';

export type ChatQuoteAnchor = {
    text: string;
    prefix: string;
    suffix: string;
    start: number;
    page?: { partId: string; kind?: 'ui' };
};

export const chatQuoteAnchorSchema = z.object({
    text: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    start: z.number(),
    page: z.object({ partId: z.string(), kind: z.literal('ui').optional() }).optional(),
});

const CONTEXT_LENGTH = 32;
const MAX_OCCURRENCES = 200;

const CHAT_QUOTE_ROOT_SELECTOR = '[data-chat-quote-root]';

export function findChatQuoteRoots(scope: ParentNode, messageId: string): Element[] {
    return [...scope.querySelectorAll(`[data-message-id="${CSS.escape(messageId)}"]`)]
        .flatMap((message) => message.querySelector(CHAT_QUOTE_ROOT_SELECTOR) ?? [])
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
}

export function findUiRenderQuoteRoot(scope: ParentNode, messageId: string, partId: string): Element | null {
    return scope.querySelector(`[data-ui-render-message="${CSS.escape(messageId)}"][data-ui-render-part="${CSS.escape(partId)}"]`);
}

function hasContextAt(stream: string, anchor: ChatQuoteAnchor, index: number): boolean {
    const end = index + anchor.text.length;
    const before = stream.slice(Math.max(0, index - anchor.prefix.length), index);
    const after = stream.slice(end, end + anchor.suffix.length);
    return anchor.prefix.endsWith(before) && anchor.suffix.startsWith(after);
}

function streamOffset(root: Node, container: Node, offset: number): number {
    const probe = root.ownerDocument!.createRange();
    probe.setStart(root, 0);
    probe.setEnd(container, offset);
    return probe.toString().length;
}

function joinStreams(roots: readonly Element[]) {
    const bases: number[] = [];
    let stream = '';
    for (const root of roots) {
        bases.push(stream.length);
        stream += root.textContent ?? '';
    }
    return { stream, bases };
}

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

export function locateChatQuote(stream: string, anchor: ChatQuoteAnchor): number | null {
    if (!anchor.text) return null;
    const occurrences: number[] = [];
    for (let index = stream.indexOf(anchor.text); index !== -1 && occurrences.length < MAX_OCCURRENCES; index = stream.indexOf(anchor.text, index + 1)) {
        occurrences.push(index);
    }
    if (occurrences.length <= 1) return occurrences[0] ?? null;
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

const PARTIAL_MATCH_LENGTH = 32;

function locateInPartialStream(stream: string, anchor: ChatQuoteAnchor): { start: number; end: number } | null {
    const { text, prefix, suffix } = anchor;
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
    const distinct = new Set(candidates.map((candidate) => `${candidate.start}:${candidate.end}`));
    return distinct.size === 1 ? candidates[0] : null;
}

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

export function resolveChatQuoteAnchor(root: Element, anchor: ChatQuoteAnchor): Range | null {
    return resolveChatQuoteRanges([root], anchor)?.[0] ?? null;
}

const gfmEntry = defaultRemarkPlugins.gfm as [Plugin<[{ singleTilde?: boolean }?], Root>, Record<string, unknown>];
const legacyQuoteParser = unified().use(remarkParse).use(gfmEntry[0], { singleTilde: false });

export function legacyChatQuoteAnchor(quote: string): ChatQuoteAnchor {
    const text = (node: Root | RootContent): string => {
        if ('children' in node) {
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
