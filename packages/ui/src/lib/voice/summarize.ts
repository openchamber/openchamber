/**
 * Text summarization utility
 * 
 * Calls the server-side text summarization endpoint which uses
 * the opencode.ai zen API with gpt-5-nano.
 */

import { useConfigStore } from '@/stores/useConfigStore';

const resolveSummarizeUrl = (): string => {
    if (typeof window === 'undefined') {
        return '/api/text/summarize';
    }

    const desktopServer = (window as typeof window & {
        __OPENCHAMBER_DESKTOP_SERVER__?: { origin: string };
    }).__OPENCHAMBER_DESKTOP_SERVER__;
    const baseOrigin = desktopServer?.origin || window.location.origin;
    return new URL('/api/text/summarize', baseOrigin).toString();
};

/**
 * Summarize text using the server-side zen API endpoint
 * 
 * @param text - The text to summarize
 * @param options - Optional configuration
 * @returns The summarized text, or original text if summarization fails
 */
export async function summarizeText(
    text: string,
    options?: {
        /** Character threshold - don't summarize if under this length */
        threshold?: number;
        /** Max characters for the summary output */
        maxLength?: number;
        /** Summarization mode */
        mode?: 'tts' | 'note';
    }
): Promise<string> {
    const store = useConfigStore.getState();
    const threshold = options?.threshold ?? store.summarizeCharacterThreshold;
    const maxLength = options?.maxLength ?? store.summarizeMaxLength;
    const mode = options?.mode ?? 'tts';
    const normalizedSource = text.replace(/\s+/g, ' ').trim();
    
    // Don't summarize if text is under threshold
    if (text.length <= threshold) {
        if (mode === 'note') {
            throw new Error('Note summarization threshold bypass is not allowed');
        }
        return text;
    }
    
    try {
         const response = await fetch(resolveSummarizeUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
             body: JSON.stringify({ text, threshold, maxLength, mode }),
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[summarize] HTTP error ${response.status}:`, errorText);
            throw new Error(`Summarization failed: ${response.status}`);
        }
        
        const data = await response.json() as {
            summarized: boolean;
            summary?: string;
            reason?: string;
            originalLength?: number;
            summaryLength?: number;
        };
        
        if (typeof data.summary === 'string' && data.summary.trim().length > 0) {
            const summary = data.summary.trim();
            if (mode === 'note') {
                const normalizedSummary = summary.replace(/\s+/g, ' ').trim();
                if (normalizedSummary === normalizedSource) {
                    throw new Error('Note distillation returned source text unchanged');
                }
            }
            return summary;
        }
        
        if (mode === 'note') {
            throw new Error('Note summarization returned no distilled result');
        }
        // Return original text if the server produced nothing usable
        return text;
    } catch (err) {
        console.error('[summarize] Failed to summarize:', err);
        if (mode === 'note') {
            throw err instanceof Error ? err : new Error('Note summarization failed');
        }
        // Return original text on error
        return text;
    }
}

/**
 * Check if text should be summarized based on settings
 */
export function shouldSummarize(
    text: string,
    context: 'message' | 'voice'
): boolean {
    const store = useConfigStore.getState();
    
    const isEnabled = context === 'message' 
        ? store.summarizeMessageTTS 
        : store.summarizeVoiceConversation;
    
    if (!isEnabled) {
        return false;
    }
    
    return text.length > store.summarizeCharacterThreshold;
}

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
