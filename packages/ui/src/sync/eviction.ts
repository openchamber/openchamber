import type { DisposeCheck, EvictPlan, State } from "./types"

/**
 * Returns true when the directory's child store holds at least one pending
 * blocking request — a question awaiting an answer or a permission awaiting
 * approval. Such directories must never be evicted, otherwise the SSE-routed
 * request data is lost and the user can never satisfy the agent.
 *
 * Tracks the same `state.question` / `state.permission` shape that
 * {@link bootstrapDirectory} re-hydrates on a fresh `ensureChild` call —
 * an empty record key (e.g. after a `question.replied` event clears the
 * array) is treated as "no pending requests" so a fully resolved directory
 * remains a normal eviction candidate.
 */
export function hasPendingBlockingRequests(state: State | undefined): boolean {
  if (!state) return false
  for (const list of Object.values(state.question ?? {})) {
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
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .filter((dir) => !input.hasPendingBlockingRequests?.(dir))
    .slice()
    .sort((a, b) => (input.state.get(a)?.lastAccessAt ?? 0) - (input.state.get(b)?.lastAccessAt ?? 0))
  const output: string[] = []
  for (const dir of sorted) {
    const last = input.state.get(dir)?.lastAccessAt ?? 0
    const idle = input.now - last >= input.ttl
    if (!idle && pendingOverflow <= 0) continue
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
