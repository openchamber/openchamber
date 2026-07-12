import type { Part } from '@opencode-ai/sdk/v2';

export function getMessageFullText(parts: Part[]): string {
    return parts
        .filter((part): part is Part & { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
}

export function getMessagePreview(parts: Part[], maxLength = 80): string {
    const full = getMessageFullText(parts);
    const singleLine = full.replace(/\n/g, ' ');
    return singleLine.length > maxLength ? singleLine.slice(0, maxLength) : singleLine;
}

export function getSearchSnippet(text: string, query: string, contextChars = 30): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}
