export const quoteDisplayText = (markdown: string): string =>
    markdown
        .split('\n')
        .map((line) => line
            .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
            .replace(/\*\*|__|`/g, '')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'))
        .join('\n');
