export const TOOL_DIFF_PREVIEW_MAX_CHARS = 256 * 1024;
export const TOOL_DIFF_PREVIEW_MAX_LINES = 2_000;

const getPreviewEnd = (diff: string): number | null => {
    const scanEnd = Math.min(diff.length, TOOL_DIFF_PREVIEW_MAX_CHARS);
    let lineCount = 1;

    for (let index = 0; index < scanEnd; index += 1) {
        const character = diff.charCodeAt(index);
        if (character !== 10 && character !== 13) continue;

        const separatorLength = character === 13 && diff.charCodeAt(index + 1) === 10 ? 2 : 1;
        if (index + separatorLength < diff.length) {
            lineCount += 1;
            if (lineCount > TOOL_DIFF_PREVIEW_MAX_LINES) return index;
        }
        if (separatorLength === 2) index += 1;
    }

    return scanEnd < diff.length ? scanEnd : null;
};

export const isToolDiffPreviewOversized = (diff: string): boolean => getPreviewEnd(diff) !== null;

/**
 * The character budget counts UTF-16 units, so it can land between the two
 * halves of an astral character (an emoji in a patched string, say). Cutting
 * there leaves a lone surrogate that renders as the replacement glyph, so step
 * back one unit when the boundary splits a pair.
 */
const withoutSplitSurrogate = (diff: string, previewEnd: number): number => {
    const lastUnit = diff.charCodeAt(previewEnd - 1);
    const isHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
    return isHighSurrogate ? previewEnd - 1 : previewEnd;
};

export const getToolDiffPreviewText = (diff: string): string => {
    const previewEnd = getPreviewEnd(diff);
    if (previewEnd === null) return diff;
    return `${diff.slice(0, withoutSplitSurrogate(diff, previewEnd)).trimEnd()}\n…`;
};
