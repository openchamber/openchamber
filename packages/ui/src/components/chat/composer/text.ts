/**
 * Text-splicing rules for the composer.
 *
 * Everything that inserts into the prompt — dictation, preset chips, pasted
 * images, dropped files, revert-to-message — has to decide how the new text
 * meets the text already there. These are those decisions, kept together and
 * away from the component so they can be reasoned about (and tested) as plain
 * string functions.
 */

/**
 * Append `next` as its own block, separated by a blank line, and leave a blank
 * line after it so the user's caret starts on a fresh paragraph. Used when the
 * inserted text is a self-contained chunk (a reverted message, a quoted
 * excerpt) rather than a continuation of the sentence.
 */
export function appendWithLineBreaks(base: string, next: string): string {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
}

/**
 * Append `next` to the end of the current sentence, with exactly one space
 * between them and a trailing space so the user can keep typing. Used for
 * dictation and for file mentions added from a drop.
 */
export function appendInlineText(base: string, next: string): string {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
}

/**
 * Pad an insertion so it does not fuse with its neighbours, without adding
 * space where the surrounding punctuation already reads correctly: no space
 * after an opening bracket, none before a closing one or before sentence
 * punctuation.
 */
export function withInlineInsertionBoundaries(
    content: string,
    before: string,
    after: string,
): string {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
}

/**
 * Pasting an image alongside text: the citation goes after whatever text came
 * with it, separated by a space.
 */
export function buildImagePasteInsertion(pastedText: string, citationText: string): string {
    if (!pastedText) {
        return citationText;
    }
    return `${pastedText}${/\s$/.test(pastedText) ? '' : ' '}${citationText}`;
}

/**
 * A single-line URL pasted over a selection becomes a markdown link rather
 * than replacing the selected text.
 */
const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;

/**
 * Whether a pasted URL should wrap the selection as `[selected](url)`. A URL
 * containing whitespace is not one, and text that already looks like a link
 * is left alone rather than nested.
 */
export function shouldWrapSelectionAsLink(url: string, selected: string): boolean {
    return PASTE_LINK_URL_PATTERN.test(url)
        && !/\s/.test(url)
        && selected.trim().length > 0
        && !selected.includes('](');
}
