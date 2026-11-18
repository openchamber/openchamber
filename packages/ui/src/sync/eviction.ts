import type { DisposeCheck, EvictPlan, State } from "./types"

export function hasPendingBlockingRequests(state: State | undefined): boolean {
  if (!state) return false
  for (const list of Object.values(state.form ?? {})) {
    if (list && list.length > 0) return true
  }
  for (const list of Object.values(state.permission ?? {})) {
    if (list && list.length > 0) return true
  }
  return false
}

export function pickDirectoriesToEvict(input: EvictPlan) {
  const overflow = Math.max(0, input.stores.length - input.max)
  let pendingOverflow = overflow
  const graceMs = input.graceMs ?? 0
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .filter((dir) => !input.hasPendingBlockingRequests?.(dir))
    .slice()
    .sort((a, b) => (input.state.get(a)?.lastAccessAt ?? 0) - (input.state.get(b)?.lastAccessAt ?? 0))
  const output: string[] = []
  for (const dir of sorted) {
    const last = input.state.get(dir)?.lastAccessAt ?? 0
    const age = input.now - last
    const idle = age >= input.ttl
    if (!idle && pendingOverflow <= 0) continue
    if (!idle && age < graceMs) continue
    output.push(dir)
    if (pendingOverflow > 0) pendingOverflow -= 1
  }
  return output
}

export function canDisposeDirectory(input: DisposeCheck) {
  if (!input.directory) return false
  if (!input.hasStore) return false
  if (input.pinned) return false
  if (input.booting) return false
  if (input.loadingSessions) return false
  if (input.hasPendingBlockingRequests) return false
  return true
}
