import { parseMarkdownIntoBlocks } from 'streamdown';

const ANSWER_CHUNK_MIN_LENGTH = 3000;

const ANSWER_CHUNK_TARGET_LENGTH = 2000;

const DOCUMENT_WIDE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

const startsWithParagraphOrHeading = (block: string): boolean => (
    /^ {0,3}(#{1,6} |[\p{L}\p{N}*_`"'([!])/u.test(block)
    && !/^ {0,3}(\d+[.)] |[-*+] |```|~~~|\|)/.test(block)
);

const MAX_CACHED = 64;
const cache = new Map<string, readonly number[]>();

const NO_CUTS: readonly number[] = [];

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
    const result = offset === text.length && cuts.length > 0 ? cuts : NO_CUTS;

    cache.set(text, result);
    if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
};
