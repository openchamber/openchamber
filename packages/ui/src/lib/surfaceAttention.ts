// Whether the user can currently see this UI surface. Session "viewed" state
// (unread markers, toasts) depends on it.
//
// Browser windows answer this from document focus. A VS Code
// webview cannot — its document loses focus whenever the editor takes it while
// the chat stays on screen, and it can report focus while VS Code itself is in
// the background. The VS Code shell reports the real state from the extension
// host instead, and once reported it is authoritative for this document.

import { z } from "zod"

export const hostViewerStateSchema = z.object({
  windowFocused: z.boolean(),
  surfaceVisible: z.boolean(),
})

type HostViewerState = z.infer<typeof hostViewerStateSchema>

let hostViewerState: HostViewerState | null = null
const hostListeners = new Set<() => void>()

export function reportHostViewerState(next: HostViewerState): void {
  if (
    hostViewerState
    && hostViewerState.windowFocused === next.windowFocused
    && hostViewerState.surfaceVisible === next.surfaceVisible
  ) return
  hostViewerState = next
  for (const listener of hostListeners) listener()
}

export function isSurfaceAttended(): boolean {
  if (hostViewerState) return hostViewerState.windowFocused && hostViewerState.surfaceVisible
  return document.hasFocus()
}

/**
 * Calls `markSeen` whenever a host report changes the viewer state to seen,
 * e.g. VS Code regains focus or a collapsed chat view opens again.
 */
export function onHostSurfaceSeen(markSeen: () => void): () => void {
  const listener = () => {
    if (isSurfaceAttended()) markSeen()
  }
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}
