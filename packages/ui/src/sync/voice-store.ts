/**
 * Voice Store — voice connection and activity state.
 * Extracted from session-ui-store for subscription isolation.
 */

export type VoiceStatus = "disconnected" | "connecting" | "connected" | "error"
export type VoiceMode = "idle" | "speaking" | "listening"
