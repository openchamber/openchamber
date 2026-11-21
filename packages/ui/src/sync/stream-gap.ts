
type StreamGapListener = (runtimeKey: string) => void

const listeners = new Set<StreamGapListener>()

export function notifyStreamGap(runtimeKey: string): void {
  for (const listener of listeners) listener(runtimeKey)
}

export function subscribeStreamGap(listener: StreamGapListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
