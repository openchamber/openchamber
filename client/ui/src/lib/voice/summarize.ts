/**
 * Client-side text sanitization for TTS output.
 * Removes markdown, URLs, file paths, and other non-speakable content.
 * Applied as a fallback when server-side summarization is skipped.
 */
export function sanitizeForTTS(text: string): string {
    if (!text) return '';
    return text
        // Remove fenced code blocks entirely (multi-line code is unreadable),
        // but keep inline-code CONTENT and only strip the backticks: agents
        // routinely inline meaningful words ("You are on `main`").
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`\n]*)`/g, '$1')
        // Remove markdown formatting
        .replace(/[*_~#]/g, '')
        // Remove URLs
        .replace(/https?:\/\/[^\s]+/g, '')
        // Remove absolute file paths (leading slash, one or more segments).
        // Deliberately NOT matching interword slashes: "iOS/Android" and
        // "origin/main" are speech, not paths.
        .replace(/(^|\s)\/(?:[\w.-]+\/)*[\w.-]+/g, '$1')
        // Read remaining interword slashes out loud ("iOS slash Android").
        .replace(/([\w.])\/([\w.])/g, '$1 slash $2')
        // Remove shell-like patterns
        .replace(/^\s*[$#>]\s*/gm, '')
        // Remove brackets and special chars
        .replace(/[[\]{}()<>|&;]/g, ' ')
        .replace(/\\/g, '')
        // Collapse whitespace
        .replace(/\s+/g, ' ')
        .trim();
}
