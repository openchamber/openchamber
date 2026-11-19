export type FileMentionAutocompleteInputSource = 'manual' | 'paste';

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

    if (textAfterAt.startsWith(' ') || !continuesPastSpace?.(textAfterAt)) {
        return null;
    }
    return textAfterAt;
};
