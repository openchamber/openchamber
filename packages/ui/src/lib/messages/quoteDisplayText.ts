import { CHAT_QUOTE_CONTEXT_LENGTH, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { proseTextDirection, type TextDirection } from '@/lib/i18n/textDirection';

export const quoteDisplayText = (markdown: string): string =>
    markdown
        .split('\n')
        .map((line) => line
            .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
            .replace(/\*\*|__|`/g, '')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'))
        .join('\n');

const stripLeadingLowSurrogate = (text: string): string => {
    const code = text.charCodeAt(0);
    return code >= 0xdc00 && code <= 0xdfff ? text.slice(1) : text;
};

const stripTrailingHighSurrogate = (text: string): string => {
    const code = text.charCodeAt(text.length - 1);
    return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
};

export type ChatQuoteExcerpt = {
    prefix: string;
    quote: string;
    suffix: string;
    hasContext: boolean;
    dir?: TextDirection;
};

export const chatQuoteExcerpt = (
    markdown: string,
    anchor?: Pick<ChatQuoteAnchor, 'prefix' | 'suffix'> & { start?: number },
): ChatQuoteExcerpt => {
    const displayQuote = quoteDisplayText(markdown);
    const trimmedQuote = displayQuote.trim();
    const rawPrefix = anchor?.prefix ?? '';
    const rawSuffix = anchor?.suffix ?? '';
    const cleanPrefix = stripLeadingLowSurrogate(rawPrefix).replace(/\s+/g, ' ').trimStart();
    const cleanSuffix = stripTrailingHighSurrogate(rawSuffix).replace(/\s+/g, ' ').trimEnd();
    const hasContext = trimmedQuote.length > 0 && (cleanPrefix.length > 0 || cleanSuffix.length > 0);
    if (!hasContext) {
        return { prefix: '', quote: displayQuote, suffix: '', hasContext: false, dir: proseTextDirection(displayQuote) };
    }
    const prefixClipped = rawPrefix.length >= CHAT_QUOTE_CONTEXT_LENGTH
        && (anchor?.start === undefined || anchor.start > rawPrefix.length);
    const suffixClipped = rawSuffix.length >= CHAT_QUOTE_CONTEXT_LENGTH;
    const leadingGap = displayQuote !== displayQuote.trimStart() && !cleanPrefix.endsWith(' ') ? ' ' : '';
    const trailingGap = displayQuote !== displayQuote.trimEnd() && !cleanSuffix.startsWith(' ') ? ' ' : '';
    const prefix = cleanPrefix ? `${prefixClipped ? '…' : ''}${cleanPrefix}${leadingGap}` : '';
    const suffix = cleanSuffix ? `${trailingGap}${cleanSuffix}${suffixClipped ? '…' : ''}` : '';
    return {
        prefix,
        quote: trimmedQuote,
        suffix,
        hasContext: true,
        dir: proseTextDirection(`${cleanPrefix}${leadingGap}${trimmedQuote}${trailingGap}${cleanSuffix}`),
    };
};
