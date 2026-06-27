/**
 * Voice hooks for session-to-voice event routing
 * Routes session events (messages, permissions, ready events) to the ElevenLabs
 * voice agent via contextual updates.
 *
 * This module provides hooks that can be called when session events occur,
 * using the voice session registry from voiceSession.ts.
 *
 * @example
 * ```typescript
 * import { voiceHooks } from '@/lib/voice';
 *
 * // Route session messages to voice
 * voiceHooks.onMessages(sessionId, messages);
 * ```
 */

import { VOICE_CONFIG } from "./voiceConfig";
import {
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    type VoiceMessage,
} from "./contextFormatters";
import { getVoiceSession, isVoiceSessionStarted } from "./voiceSession";

/**
 * Report a contextual update to the voice session
 * Internal helper that checks preconditions and handles errors
 *
 * @param update - The text update to send, or null/undefined to skip
 */
function reportContextualUpdate(update: string | null | undefined): void {
    // Skip empty/null/undefined updates
    if (!update || update.trim().length === 0) {
        return;
    }

    // Skip if no voice session or not started
    const voiceSession = getVoiceSession();
    if (!voiceSession || !isVoiceSessionStarted()) {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log("[Voice] Skipping contextual update - no active session");
        }
        return;
    }

    try {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log("[Voice] Sending contextual update:", update.substring(0, 100));
        }
        voiceSession.sendContextualUpdate(update);
    } catch (error) {
        // Log error but don't throw - voice updates shouldn't break the app
        console.error("[Voice] Failed to send contextual update:", error);
    }
}

/**
 * Voice hooks - exported functions to route session events to voice
 *
 * These hooks should be called when corresponding session events occur.
 * They respect VOICE_CONFIG feature flags to enable/disable specific
 * event types.
 */
export const voiceHooks = {
    /**
     * Called when new messages arrive in the session
     * Formats and sends messages to voice agent (if not disabled)
     *
     * @param sessionId - The session ID
     * @param messages - Array of messages to format and send
     */
    onMessages(sessionId: string, messages: VoiceMessage[]): void {
        if (VOICE_CONFIG.DISABLE_MESSAGES) {
            if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
                console.log("[Voice] Message forwarding disabled");
            }
            return;
        }
        reportContextualUpdate(formatNewMessages(sessionId, messages));
    },

    /**
     * Called when a permission request is made
     * Announces the permission request to the voice agent (if not disabled)
     *
     * @param sessionId - The session ID
     * @param requestId - The permission request ID
     * @param toolName - Name of the tool requesting permission
     * @param toolArgs - Arguments for the tool (not sent to voice per LIMITED_TOOL_CALLS)
     */
    onPermissionRequested(
        sessionId: string,
        requestId: string,
        toolName: string,
        toolArgs: unknown
    ): void {
        if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) {
            if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
                console.log("[Voice] Permission request forwarding disabled");
            }
            return;
        }
        reportContextualUpdate(
            formatPermissionRequest(sessionId, requestId, toolName, toolArgs)
        );
    },

    /**
     * Called when the AI is ready for the next instruction
     * Announces ready state to the voice agent (if not disabled)
     *
     * @param sessionId - The session ID
     */
    onReady(sessionId: string): void {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) {
            if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
                console.log("[Voice] Ready event forwarding disabled");
            }
            return;
        }
        reportContextualUpdate(formatReadyEvent(sessionId));
    },
};
