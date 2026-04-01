/**
 * Voice Store — voice connection and activity state.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"

export type VoiceStatus = "disconnected" | "connecting" | "connected" | "error"
export type VoiceMode = "idle" | "speaking" | "listening"

export type VoiceState = {
  voiceStatus: VoiceStatus
  voiceMode: VoiceMode
  setVoiceStatus: (status: VoiceStatus) => void
  setVoiceMode: (mode: VoiceMode) => void
}

export const useVoiceStore = create<VoiceState>()((set) => ({
  voiceStatus: "disconnected",
  voiceMode: "idle",
  setVoiceStatus: (status) => set({ voiceStatus: status }),
  setVoiceMode: (mode) => set({ voiceMode: mode }),
}))
