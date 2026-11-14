/**
 * A gap in the live event stream: a reconnect after a disconnect, or a
 * transport switch. Events sent during it may be lost, so readers that rely on
 * the stream to stay current (the global session list) read once after it,
 * instead of polling while the stream is healthy.
 */

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
