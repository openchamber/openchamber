/**
 * Client-side text sanitization for TTS output.
 * Removes markdown, URLs, file paths, and other non-speakable content.
 * Applied as a fallback when server-side summarization is skipped.
 */
export function sanitizeForTTS(text: string): string {
    if (!text) return '';
    return text
        // Remove code blocks
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]*`/g, '')
        // Remove markdown formatting
        .replace(/[*_~#]/g, '')
        // Remove URLs
        .replace(/https?:\/\/[^\s]+/g, '')
        // Remove file paths
        .replace(/\/[\w\-./]+/g, '')
        // Remove shell-like patterns
        .replace(/^\s*[$#>]\s*/gm, '')
        // Remove brackets and special chars
        .replace(/[[\]{}()<>|&;]/g, ' ')
        .replace(/\\/g, '')
        // Collapse whitespace
        .replace(/\s+/g, ' ')
        .trim();
}
