/**
 * A chat quote is kept as the Markdown of the selection, because that is what
 * the model reads. Shown back to the user in the composer and on the sent
 * card, the markers are noise: this drops emphasis, inline code ticks, link
 * targets and the line-leading list, quote and heading markers, and keeps the
 * words and line breaks. Single `*` and `_` stay, since they often belong to
 * the text (`snake_case`, `a * b`).
 */
export const quoteDisplayText = (markdown: string): string =>
    markdown
        .split('\n')
        .map((line) => line
            .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
            .replace(/\*\*|__|`/g, '')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'))
        .join('\n');
