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

export const getToolDiffPreviewText = (diff: string): string => {
    const previewEnd = getPreviewEnd(diff);
    if (previewEnd === null) return diff;
    return `${diff.slice(0, previewEnd).trimEnd()}\n…`;
};
