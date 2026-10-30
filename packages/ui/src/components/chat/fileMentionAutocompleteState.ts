export type FileMentionAutocompleteInputSource = 'manual' | 'paste';

/**
 * The `@` query being typed at the caret, or null. A newline always ends it.
 * A space ends it too, because paths and agent names hold none, unless
 * `continuesPastSpace` says the whole query still names something with
 * spaces in it, such as a session title.
 */
export const getFileMentionAutocompleteQuery = ({
    value,
    cursorPosition,
    inputSource = 'manual',
    insertedText,
    continuesPastSpace,
    isCompleted,
}: {
    value: string;
    cursorPosition: number;
    inputSource?: FileMentionAutocompleteInputSource;
    insertedText?: string;
    continuesPastSpace?: (query: string) => boolean;
    /** Explicit selection completed the reference containing this @ offset. */
    isCompleted?: (start: number) => boolean;
}): string | null => {
    if (inputSource === 'paste' && insertedText?.includes('@')) {
        return null;
    }

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol === -1 || isCompleted?.(lastAtSymbol)) {
        return null;
    }

    const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
    const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (!isWordBoundary || textAfterAt.includes('\n')) {
        return null;
    }
    if (!textAfterAt.includes(' ')) {
        return textAfterAt;
    }

    // A bare `@ ` is punctuation, not the start of a title.
    if (textAfterAt.startsWith(' ') || !continuesPastSpace?.(textAfterAt)) {
        return null;
    }
    return textAfterAt;
};
