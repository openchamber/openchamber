/**
 * Voice session interface
 * Used for type safety without importing ReturnType from SDK
 */
interface VoiceSession {
    sendContextualUpdate: (text: string) => void;
}

/**
 * Global storage for the active voice session.
 * Used by voiceHooks to send contextual updates to the voice agent.
 */
const activeVoiceSession: VoiceSession | null = null;

/**
 * Get the currently registered voice session.
 * Used by voiceHooks to send contextual updates.
 */
export function getVoiceSession(): VoiceSession | null {
    return activeVoiceSession;
}

/**
 * Check if a voice session is currently active.
 */
export function isVoiceSessionStarted(): boolean {
    return activeVoiceSession !== null;
}
