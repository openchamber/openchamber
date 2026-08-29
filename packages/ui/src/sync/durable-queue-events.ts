import { runtimeFetch } from '@/lib/runtime-fetch'
import { createMessageQueueTarget, useMessageQueueStore, type DurableQueueAdmission, type MessageQueueTarget } from '@/stores/messageQueueStore'

type DurableEvent = {
  type?: unknown
  data?: unknown
  properties?: unknown
  durable?: unknown
  sequence?: unknown
  aggregateSequence?: unknown
  seq?: unknown
  aggregateSeq?: unknown
  syncEvent?: unknown
}

const queueKey = (target: MessageQueueTarget): string =>
  `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`

const cursors = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
const replayControllers = new Map<string, AbortController>()
type ReplayGeneration = { invalidated: boolean; complete: boolean }
const replayGenerations = new Map<string, ReplayGeneration>()
const initializedHistory = new Set<string>()
const unsupportedHistoryRuntimes = new Map<string, number>()
const MAX_CURSOR_ENTRIES = 100
const MAX_IN_FLIGHT_REPLAYS = 100
const MAX_REPLAY_GENERATIONS = 100
const HISTORY_TIMEOUT_MS = 15_000
const UNSUPPORTED_CACHE_TTL_MS = 5 * 60 * 1000

const propsOf = (event: DurableEvent): Record<string, unknown> =>
  (event.data ?? event.properties) && typeof (event.data ?? event.properties) === 'object' && !Array.isArray(event.data ?? event.properties)
    ? (event.data ?? event.properties) as Record<string, unknown>
    : {}

const numberValue = (...values: unknown[]): number | undefined =>
  values.find((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)

const finiteNumberValue = (...values: unknown[]): number | undefined =>
  values.find((value): value is number => typeof value === 'number' && Number.isFinite(value))

const admissionFromEvent = (event: DurableEvent): DurableQueueAdmission | null => {
  const props = propsOf(event)
  const rawCandidate = props.admission ?? props.input ?? props.info ?? props
  const raw = rawCandidate && typeof rawCandidate === 'object' ? rawCandidate as Record<string, unknown> : props
  // messageID is the client-supplied idempotency key. Do not fall back to a
  // content-derived identity (or a server queue-entry id): reconciliation is
  // intentionally exact-id only.
  const id = typeof raw.messageID === 'string' ? raw.messageID : null
  const sessionID = typeof raw.sessionID === 'string' ? raw.sessionID : typeof props.sessionID === 'string' ? props.sessionID : null
  if (!id || !sessionID) return null
  const prompt = raw.prompt && typeof raw.prompt === 'object' ? raw.prompt as DurableQueueAdmission['prompt'] : undefined
  return { id, sessionID, prompt, admittedSeq: numberValue(raw.admittedSeq, props.admittedSeq), timeCreated: finiteNumberValue(raw.timestamp, raw.timeCreated, props.timestamp, props.timeCreated) }
}

const sequenceOfEvent = (event: DurableEvent): number | undefined => {
  const syncEvent = event.syncEvent && typeof event.syncEvent === 'object' ? event.syncEvent as DurableEvent : null
  const envelope = syncEvent ?? event
  return numberValue(
    syncEvent?.seq,
    envelope.durable && typeof envelope.durable === 'object' ? (envelope.durable as Record<string, unknown>).seq : undefined,
    envelope.aggregateSequence, envelope.aggregateSeq, envelope.sequence, envelope.seq,
  )
}

const pruneReplayGenerations = (): void => {
  if (replayGenerations.size <= MAX_REPLAY_GENERATIONS) return
  for (const [key, generation] of replayGenerations) {
    if (replayGenerations.size <= MAX_REPLAY_GENERATIONS) break
    if (generation.complete) replayGenerations.delete(key)
  }
}

export const applyDurableQueueEvent = (target: MessageQueueTarget, event: DurableEvent): void => {
  const syncEvent = event.syncEvent && typeof event.syncEvent === 'object' ? event.syncEvent as DurableEvent : null
  const envelope = syncEvent ?? event
  const type = typeof envelope.type === 'string' ? envelope.type : ''
  const durableType = type.replace(/\.\d+$/, '')
  const admission = admissionFromEvent(envelope)
  const delivery = propsOf(envelope).delivery
  const sequence = numberValue(
    (event.syncEvent && typeof event.syncEvent === 'object' ? (event.syncEvent as DurableEvent).seq : undefined),
    envelope.durable && typeof envelope.durable === 'object' ? (envelope.durable as Record<string, unknown>).seq : undefined,
    envelope.aggregateSequence, envelope.aggregateSeq, envelope.sequence, envelope.seq,
  )
  if (durableType === 'session.next.prompt.admitted' && admission && delivery === 'queue') {
    useMessageQueueStore.getState().upsertDurableAdmission(target, { ...admission, durableSeq: sequence })
  } else if (durableType === 'session.next.prompted' && admission && delivery === 'queue') {
    useMessageQueueStore.getState().removeDurableAdmission(target, admission.id, sequence)
  }
  if (sequence !== undefined) {
    const key = queueKey(target)
    cursors.set(key, Math.max(sequence, cursors.get(key) ?? 0))
    if (cursors.size > MAX_CURSOR_ENTRIES) {
      for (const oldestKey of cursors.keys()) {
        if (oldestKey !== key) {
          cursors.delete(oldestKey)
          initializedHistory.delete(oldestKey)
          break
        }
      }
    }
  }
}

export async function replayDurableQueueHistory(target: MessageQueueTarget, signal?: AbortSignal): Promise<void> {
  const key = queueKey(target)
  const previous = inFlight.get(key)
  const previousController = replayControllers.get(key)
  const previousGeneration = replayGenerations.get(key)
  if (previous && previousController && !previousController.signal.aborted && !previousGeneration?.invalidated) return previous
  if (previous) {
    // An aborted caller or invalidation must not make a later mount share its
    // dead replay. Mark its generation before dropping handles so a response
    // already in flight cannot commit into the new caller's lifecycle.
    if (previousGeneration) previousGeneration.invalidated = true
    previousController?.abort()
    inFlight.delete(key)
    replayControllers.delete(key)
  }
  if (signal?.aborted) return
  const unsupportedAt = unsupportedHistoryRuntimes.get(target.runtimeKey)
  if (unsupportedAt !== undefined) {
    if (Date.now() - unsupportedAt < UNSUPPORTED_CACHE_TTL_MS) return
    unsupportedHistoryRuntimes.delete(target.runtimeKey)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS)
  const abort = () => controller.abort()
  const generation: ReplayGeneration = { invalidated: false, complete: false }
  signal?.addEventListener('abort', abort, { once: true })
  replayControllers.set(key, controller)
  replayGenerations.set(key, generation)
  let completedSuccessfully = false
  const task = (async () => {
    // The first replay always asks for sequence zero. Live events observed
    // while it is in flight must not move that starting point.
    const initialReplay = !initializedHistory.has(key)
    let after = initialReplay ? 0 : cursors.get(key) ?? 0
    let hasMore = true
    for (let page = 0; hasMore && page < 100; page += 1) {
      if (controller.signal.aborted) return
      const pageAfter = after
      const response = await runtimeFetch(`/api/session/${encodeURIComponent(target.sessionId)}/history`, {
        method: 'GET', query: initialReplay && page === 0
          ? { directory: target.directory }
          : { directory: target.directory, after: String(pageAfter) }, signal: controller.signal,
      })
      if (replayGenerations.get(key) !== generation || generation.invalidated || controller.signal.aborted) return
      if (!response.ok) {
        // Cache only stable route/capability rejections. 4xx authorization,
        // session, and validation failures remain observable and retryable.
        if (response.status === 405 || response.status === 501) {
          unsupportedHistoryRuntimes.set(target.runtimeKey, Date.now())
        }
        return
      }
      const result = await response.json() as { data?: unknown; hasMore?: unknown }
      const events = Array.isArray(result.data) ? result.data : []
      let pageNext = pageAfter
      for (const event of events) {
        const durableEvent = event as DurableEvent
        applyDurableQueueEvent(target, durableEvent)
        pageNext = Math.max(pageNext, sequenceOfEvent(durableEvent) ?? pageNext)
      }
      hasMore = result.hasMore === true
      // Do not read the live cursor here: a live event can advance it while
      // this HTTP page is in flight, and using it would skip history pages.
      const next = pageNext
      if (next <= pageAfter && hasMore) return
      after = next
    }
    if (!hasMore && !controller.signal.aborted && replayGenerations.get(key) === generation && !generation.invalidated) {
      completedSuccessfully = true
    }
  })().catch(() => undefined).finally(() => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    generation.complete = true
    if (replayGenerations.get(key) === generation) {
      // A failed or cancelled first replay must start at sequence zero next time.
      if (completedSuccessfully) initializedHistory.add(key)
      inFlight.delete(key)
      replayControllers.delete(key)
      replayGenerations.delete(key)
    }
    pruneReplayGenerations()
  })
  inFlight.set(key, task)
  if (inFlight.size > MAX_IN_FLIGHT_REPLAYS) {
    const oldestKey = inFlight.keys().next().value
    if (typeof oldestKey === 'string' && oldestKey !== key) {
      replayControllers.get(oldestKey)?.abort()
      const oldestGeneration = replayGenerations.get(oldestKey)
      if (oldestGeneration) oldestGeneration.invalidated = true
      inFlight.delete(oldestKey)
      replayControllers.delete(oldestKey)
      if (oldestGeneration?.complete) replayGenerations.delete(oldestKey)
    }
  }
  return task
}

export const durableQueueTarget = (sessionId: string, directory: string | null, runtimeKey: string): MessageQueueTarget | null =>
  createMessageQueueTarget(sessionId, directory, runtimeKey)

export const resetDurableQueueCursors = (): void => {
  for (const controller of replayControllers.values()) controller.abort()
  cursors.clear()
  initializedHistory.clear()
  unsupportedHistoryRuntimes.clear()
  inFlight.clear()
  replayControllers.clear()
  replayGenerations.clear()
}

/** Cancel history replay for a deleted target so an already-fetched stale page cannot re-admit it. */
export const invalidateDurableQueueTarget = (target: MessageQueueTarget): void => {
  const key = queueKey(target)
  const generation = replayGenerations.get(key)
  if (generation) generation.invalidated = true
  replayControllers.get(key)?.abort()
  // Publish a new invalidated generation before dropping the active handles.
  // Any response that was already fetched must fail the identity check even
  // if its abort notification is delivered later.
  replayGenerations.set(key, { invalidated: true, complete: true })
  inFlight.delete(key)
  replayControllers.delete(key)
  cursors.delete(key)
  initializedHistory.delete(key)
  pruneReplayGenerations()
}

if (typeof window !== 'undefined') {
  window.addEventListener('openchamber:runtime-endpoint-changed', resetDurableQueueCursors)
}
