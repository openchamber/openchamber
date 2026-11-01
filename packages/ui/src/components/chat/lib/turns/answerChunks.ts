import { parseMarkdownIntoBlocks } from 'streamdown';

/** A finished text part this long is drawn as several list rows. */
const ANSWER_CHUNK_MIN_LENGTH = 3000;

// Roughly a screen of prose at the chat's width.
const ANSWER_CHUNK_TARGET_LENGTH = 2000;

// A footnote or a link reference definition resolves across the whole
// document; cut apart, a chunk would lose what another one defines.
const DOCUMENT_WIDE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

// Where a chunk may start: a paragraph or a heading. Its top margin is then the
// whole gap the document puts above it (no block's bottom margin is larger),
// so the rows stack exactly as the document did. A list, a table, a code
// block or HTML collapses margins through its children differently.
const startsWithParagraphOrHeading = (block: string): boolean => (
    /^ {0,3}(#{1,6} |[\p{L}\p{N}*_`"'([!])/u.test(block)
    && !/^ {0,3}(\d+[.)] |[-*+] |```|~~~|\|)/.test(block)
);

const MAX_CACHED = 64;
const cache = new Map<string, readonly number[]>();

const NO_CUTS: readonly number[] = [];

/**
 * Offsets in `text` where a chunk after the first one starts, empty when the
 * text stays one piece. Cuts fall only between Markdown blocks, and the
 * blocks join back into the text exactly.
 */
export const answerChunkCuts = (text: string): readonly number[] => {
    if (text.length < ANSWER_CHUNK_MIN_LENGTH || DOCUMENT_WIDE_DEFINITION.test(text)) return NO_CUTS;
    const cached = cache.get(text);
    if (cached) return cached;

    const cuts: number[] = [];
    let offset = 0;
    let chunkStart = 0;
    for (const block of parseMarkdownIntoBlocks(text)) {
        if (offset - chunkStart >= ANSWER_CHUNK_TARGET_LENGTH
            && text.length - offset >= ANSWER_CHUNK_TARGET_LENGTH / 2
            && startsWithParagraphOrHeading(block)) {
            cuts.push(offset);
            chunkStart = offset;
        }
        offset += block.length;
    }
    // The blocks must add up to the text, or the offsets mean nothing.
    const result = offset === text.length && cuts.length > 0 ? cuts : NO_CUTS;

    cache.set(text, result);
    if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
};
