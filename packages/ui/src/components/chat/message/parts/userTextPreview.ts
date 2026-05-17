/**
 * Helpers for rendering a one-line preview of a user message when the
 * message is collapsed. The collapsed state must NOT rely on CSS
 * `line-clamp-*`, which silently fails on block-level descendants
 * (`<pre>`, `<ul>`, `<blockquote>`, etc.) and lets the message keep
 * its full block height.
 */

/**
 * Convert a raw user message string into a single-line, plain-text
 * preview suitable for an inline collapsed header.
 *
 * - Strips fenced/inline code markers, blockquote and list markers,
 *   ATX headings, and common emphasis runs.
 * - Collapses all internal whitespace (including newlines) to one
 *   space character.
 * - Truncates with `…` when over `maxChars`.
 *
 * The result is never longer than `maxChars` characters (the ellipsis
 * counts toward the limit).
 */
export const buildUserTextPreview = (text: string, maxChars: number = 120): string => {
    if (!text) return '';

    let working = text;

    // Drop fenced code blocks entirely; keep their inner text as a hint.
    working = working.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, inner) => inner ?? '');

    // Strip inline code backticks but keep contents.
    working = working.replace(/`([^`]+)`/g, '$1');

    // Per-line strip: ATX headings, blockquotes, list markers.
    working = working
        .split('\n')
        .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[>*+-]\s+|\d+\.\s+)/, ''))
        .join('\n');

    // Strip simple bold/italic markers.
    working = working
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1');

    // Collapse all whitespace to single spaces.
    const flattened = working.replace(/\s+/g, ' ').trim();

    if (flattened.length <= maxChars) {
        return flattened;
    }

    // Reserve 1 char for the ellipsis.
    return `${flattened.slice(0, Math.max(0, maxChars - 1))}…`;
};

/**
 * Count how many additional non-empty lines exist beyond the first
 * non-empty line. Used to render a "+N lines" hint next to the
 * collapsed preview so the user knows there is more content.
 */
export const countAdditionalLines = (text: string): number => {
    if (!text) return 0;

    const nonEmpty = text.split('\n').filter((line) => line.trim().length > 0);
    if (nonEmpty.length <= 1) return 0;

    return nonEmpty.length - 1;
};
