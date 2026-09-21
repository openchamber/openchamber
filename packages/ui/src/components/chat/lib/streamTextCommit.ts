// Block-level streaming reveal.
//
// Token-by-token streaming mutates the trailing paragraph in place on every
// tick: words rewrap, the last line jitters, and the reader's eye fights the
// motion. Committing only up to the last COMPLETE line keeps every rendered
// block immutable once it appears — prose arrives a paragraph at a time (a
// markdown paragraph is one logical line), code fences reveal line by line,
// tables row by row — and the only remaining motion is the follow scroll.
//
// A paragraph with no newline for a long stretch must not stall the stream,
// so once the held tail outgrows a threshold it is committed at the last
// sentence boundary (falling back to the last word boundary).

const HOLD_MAX_CHARS = 320;

const SENTENCE_END = /[.!?…][)"'»”’]?\s/g;

export const commitStreamedText = (text: string): string => {
    if (text.length === 0) return text;

    const lastNewline = text.lastIndexOf('\n');
    const committed = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    const held = text.slice(committed.length);

    if (held.length <= HOLD_MAX_CHARS) {
        return committed;
    }

    // The held paragraph got long: release it up to the last finished
    // sentence so the block still never mutates mid-sentence.
    let lastSentenceEnd = -1;
    for (const match of held.matchAll(SENTENCE_END)) {
        lastSentenceEnd = match.index + match[0].length;
    }
    if (lastSentenceEnd > 0) {
        return committed + held.slice(0, lastSentenceEnd);
    }

    // No sentence boundary either (a URL, a very long token run): release up
    // to the last word boundary, keeping only the incomplete word held.
    const lastSpace = held.lastIndexOf(' ');
    if (lastSpace > 0) {
        return committed + held.slice(0, lastSpace + 1);
    }

    return text;
};
