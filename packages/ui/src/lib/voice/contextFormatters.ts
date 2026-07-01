/**
 * Context formatters for voice-native output
 * Formats session events (messages, permissions, ready events) into natural language
 * for the ElevenLabs voice agent to speak aloud.
 *
 * @example
 * ```typescript
 * import { formatMessage, formatPermissionRequest } from '@/lib/voice';
 *
 * const voiceText = formatMessage({ role: 'assistant', content: 'Hello!' });
 * // Returns: "Claude Code: Hello!"
 * ```
 */

import { VOICE_CONFIG } from "./voiceConfig";

/** Message type for voice formatting */
export interface VoiceMessage {
    role: string;
    content: string;
}

/**
 * Format a single message for voice output
 * - Assistant messages: Code blocks replaced with "[code block]", prefixed with "Claude Code: "
 * - User messages: Prefixed with "User: "
 * - Other roles: Returns null (not spoken)
 *
 * @param message - The message to format
 * @returns Formatted text for voice, or null if should not be spoken
 */
function formatMessage(message: VoiceMessage): string | null {
    // Handle edge cases
    if (!message || typeof message.content !== "string") {
        return null;
    }

    const content = message.content.trim();
    if (!content) {
        return null;
    }

    if (message.role === "assistant") {
        // Replace code blocks with description (don't read code aloud)
        const textOnly = content.replace(/```[\s\S]*?```/g, "[code block]");
        return `Claude Code: ${textOnly}`;
    }

    if (message.role === "user") {
        return `User: ${content}`;
    }

    // Skip system, tool, and other roles for voice
    return null;
}

/**
 * Format multiple new messages for voice output
 * - Maps messages through formatMessage
 * - Filters out nulls (unspoken roles)
 * - Joins with newlines
 *
 * @param sessionId - The session ID (for future use/debugging)
 * @param messages - Array of messages to format
 * @returns Formatted text for voice, or null if no speakable messages
 */
export function formatNewMessages(
    sessionId: string,
    messages: VoiceMessage[]
): string | null {
    // Handle edge cases
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log(`[Voice] Formatting ${messages.length} messages for session ${sessionId}`);
    }

    // Format each message and filter out nulls
    const formattedMessages = messages
        .map(formatMessage)
        .filter((msg): msg is string => msg !== null);

    if (formattedMessages.length === 0) {
        return null;
    }

    return formattedMessages.join("\n");
}

/**
 * Format a permission request for voice announcement
 * - Per CONTEXT.md: Only tool name, not arguments (LIMITED_TOOL_CALLS)
 * - Prompts user to say "allow" or "deny"
 *
 * @param sessionId - The session ID
 * @param requestId - The permission request ID
 * @param toolName - Name of the tool requesting permission
 * @param toolArgs - Tool arguments (not included in voice output per config)
 * @returns Formatted permission request for voice
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    toolArgs: unknown
): string {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log(`[Voice] Formatting permission request ${requestId} for session ${sessionId}`);
    }

    // Per VOICE_CONFIG.LIMITED_TOOL_CALLS, we don't include toolArgs in voice output
    return `Claude Code is requesting permission to use ${toolName}. Say "allow" or "deny".`;
}

/**
 * Format a ready event for voice announcement
 * - Indicates the AI has finished working and is ready for next instruction
 *
 * @param sessionId - The session ID
 * @returns Formatted ready event for voice
 */
export function formatReadyEvent(sessionId: string): string {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log(`[Voice] Formatting ready event for session ${sessionId}`);
    }

    return "Claude Code finished working. Ready for next instruction.";
}
