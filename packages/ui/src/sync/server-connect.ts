type ServerConnectListener = () => void

const listeners = new Set<ServerConnectListener>()

export function notifyServerConnect(): void {
  for (const listener of listeners) listener()
}

export function subscribeServerConnect(listener: ServerConnectListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
