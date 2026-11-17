
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

export function onHostSurfaceSeen(markSeen: () => void): () => void {
  const listener = () => {
    if (isSurfaceAttended()) markSeen()
  }
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}
