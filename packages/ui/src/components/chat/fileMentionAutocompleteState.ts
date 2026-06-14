export type FileMentionAutocompleteInputSource = 'manual' | 'paste';

export const getFileMentionAutocompleteQuery = ({
    value,
    cursorPosition,
    inputSource = 'manual',
}: {
    value: string;
    cursorPosition: number;
    inputSource?: FileMentionAutocompleteInputSource;
}): string | null => {
    if (inputSource === 'paste') {
        return null;
    }

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol === -1) {
        return null;
    }

    const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
    const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (!isWordBoundary || textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
        return null;
    }

    return textAfterAt;
};
