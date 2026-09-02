/**
 * Large plain-text paste → virtual file attachment helpers.
 *
 * Detect when clipboard text is large enough that inserting it into the
 * composer would clutter the prompt, and build an in-memory text/plain File
 * the attachment pipeline can send like any other .txt attachment.
 */

export const LARGE_TEXT_PASTE_CHAR_THRESHOLD = 2000;
export const LARGE_TEXT_PASTE_LINE_THRESHOLD = 25;

const countLines = (text: string): number => {
    let lines = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

/**
 * Whether pasted plain text should be offered (or auto-handled) as a file
 * attachment instead of being inserted into the composer.
 *
 * Empty / whitespace-only pastes are never large. Thresholds are OR'd:
 * character count or line count is enough.
 */
export const isLargePlainTextPaste = (
    text: string,
    options?: {
        charThreshold?: number;
        lineThreshold?: number;
    },
): boolean => {
    if (!text || !text.trim()) {
        return false;
    }

    const charThreshold = options?.charThreshold ?? LARGE_TEXT_PASTE_CHAR_THRESHOLD;
    const lineThreshold = options?.lineThreshold ?? LARGE_TEXT_PASTE_LINE_THRESHOLD;

    if (text.length >= charThreshold) {
        return true;
    }

    return countLines(text) >= lineThreshold;
};

export const createPastedContextFile = (text: string, filename: string): File => (
    new File([text], filename, {
        type: 'text/plain',
        lastModified: Date.now(),
    })
);
