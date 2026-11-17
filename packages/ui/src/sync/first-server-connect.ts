
import type { ChildStoreManager } from "./child-store"

type FirstServerConnectListener = (runtimeKey: string) => void

const connectedRuntimeByOwner = new WeakMap<ChildStoreManager, string>()
const listeners = new Set<FirstServerConnectListener>()

export function claimFirstServerConnect(owner: ChildStoreManager, runtimeKey: string): boolean {
  if (connectedRuntimeByOwner.get(owner) === runtimeKey) return false
  connectedRuntimeByOwner.set(owner, runtimeKey)
  return true
}

export function notifyFirstServerConnect(runtimeKey: string): void {
  for (const listener of listeners) listener(runtimeKey)
}

export function subscribeFirstServerConnect(listener: FirstServerConnectListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
