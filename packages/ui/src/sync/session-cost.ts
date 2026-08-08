/**
 * Session subtree cost aggregation.
 *
 * Owns the recursive "total cost" figure shown next to the context usage
 * indicator: the current session's own assistant-message cost plus every
 * descendant session (subagent/task sessions linked by `parentID`).
 *
 * Data sources and their authority:
 * - The session tree comes from the directory child store (`state.session`),
 *   which already contains the full parent/child hierarchy from bootstrap.
 * - Per-session cost is summed from `AssistantMessage.cost` over the synced
 *   message bucket (`state.message[sessionID]`). There is no session-level
 *   cost aggregate in the SDK.
 * - Descendants that are running stream their messages into the same store,
 *   so their contribution updates live.
 * - Descendants whose messages were never loaded this app session are
 *   lazy-fetched through the shared `SessionMessageLoader` (history walked
 *   until complete, bounded). Until coverage is known their cost is
 *   *unknown*, not zero: the result carries `pending: true` and the UI shows
 *   the total as a lower bound (`$1.23…`).
 * - Once a settled session's history is complete, its aggregate is frozen in
 *   a runtime-scoped cache so LRU eviction of its message bucket cannot make
 *   the displayed total drop. A fresh bucket always supersedes the frozen
 *   value and refreshes it once the session settles with complete history.
 */

import * as React from "react"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { useDirectoryStore, useDirectorySync, useSyncDirectory } from "./sync-context"
import type { State } from "./types"
import { computeSessionCostAndCounts } from "@/stores/utils/tokenUtils"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

export interface SessionSubtreeCost {
    /** Cost of the root session's own assistant messages (loaded coverage). */
    sessionCost: number
    /** Cost contributed by descendant sessions (loaded or frozen coverage). */
    descendantCost: number
    /** sessionCost + descendantCost. */
    totalCost: number
    /** Whether the root session has any descendant sessions. */
    hasDescendants: boolean
    /**
     * True when the total is a lower bound: a descendant is still loading,
     * has incomplete history coverage, or is currently running.
     */
    pending: boolean
}

export interface SubtreeCostSource {
    sessions: Session[]
    messages: Record<string, Message[] | undefined>
    statuses: Record<string, SessionStatus | undefined>
    /** True when the synced bucket is known to cover the session's full history. */
    isHistoryComplete: (sessionID: string) => boolean
    /** Frozen aggregate for a settled session whose bucket was evicted. */
    readFrozenCost: (sessionID: string) => number | undefined
    /** Persist the aggregate once a settled session's history is complete. */
    writeFrozenCost: (sessionID: string, cost: number) => void
}

const isActiveStatus = (status: SessionStatus | undefined): boolean => {
    const type = status?.type
    return type === "busy" || type === "retry"
}

// Per-bucket memo: a message array reference only changes when that session's
// messages change, so unchanged subtree members cost O(1) per recompute.
const bucketCostMemo = new WeakMap<Message[], number>()

const sumBucketCost = (messages: Message[]): number => {
    const cached = bucketCostMemo.get(messages)
    if (cached !== undefined) return cached
    const total = computeSessionCostAndCounts(messages).totalCost
    bucketCostMemo.set(messages, total)
    return total
}

/**
 * Pure recursive aggregation. The root session is never pending by itself
 * (its own cost simply reflects loaded coverage); only descendants drive
 * `pending`.
 */
export const computeSubtreeCost = (rootID: string, source: SubtreeCostSource): SessionSubtreeCost => {
    const ids = computeSubtreeIds(source.sessions, rootID)
    let sessionCost = 0
    let descendantCost = 0
    let pending = false

    for (const id of ids) {
        const hasBucket = Object.prototype.hasOwnProperty.call(source.messages, id)
        const bucket = hasBucket ? source.messages[id] : undefined
        const busy = isActiveStatus(source.statuses[id])

        let cost: number | undefined
        if (bucket) {
            cost = sumBucketCost(bucket)
            if (!busy && source.isHistoryComplete(id)) {
                source.writeFrozenCost(id, cost)
            }
        } else {
            cost = source.readFrozenCost(id)
        }

        if (id === rootID) {
            sessionCost = cost ?? 0
            continue
        }

        if (typeof cost === "number") {
            descendantCost += cost
        }
        if (busy) {
            // A running subagent's total is still accumulating.
            pending = true
        } else if (!bucket) {
            // Never loaded this app session and no frozen aggregate: unknown.
            if (cost === undefined) pending = true
        } else if (!source.isHistoryComplete(id)) {
            // Loaded but known to be a partial history window: lower bound.
            pending = true
        }
    }

    return {
        sessionCost,
        descendantCost,
        totalCost: sessionCost + descendantCost,
        hasDescendants: ids.size > 1,
        pending,
    }
}

// ---------------------------------------------------------------------------
// Frozen aggregate cache (survives message-bucket eviction)
// ---------------------------------------------------------------------------

const MAX_FROZEN_ENTRIES = 500
const frozenCosts = new Map<string, number>()
let frozenVersion = 0

const frozenKey = (directory: string, sessionID: string): string => `${getRuntimeKey()}\n${directory}\n${sessionID}`

const readFrozenCost = (directory: string, sessionID: string): number | undefined =>
    frozenCosts.get(frozenKey(directory, sessionID))

const writeFrozenCost = (directory: string, sessionID: string, cost: number): void => {
    const key = frozenKey(directory, sessionID)
    if (frozenCosts.get(key) === cost) return
    if (frozenCosts.size >= MAX_FROZEN_ENTRIES && !frozenCosts.has(key)) {
        const oldest = frozenCosts.keys().next()
        if (!oldest.done) frozenCosts.delete(oldest.value)
    }
    frozenCosts.set(key, cost)
    frozenVersion += 1
}

// ---------------------------------------------------------------------------
// Lazy history loading for descendants
// ---------------------------------------------------------------------------

const inFlightCostLoads = new Set<string>()

const getMaxHistoryPages = (): number => (isVSCodeRuntime() || isMobileSurfaceRuntime() ? 10 : 50)

/**
 * Ensure a descendant session's messages are loaded with complete history so
 * its cost is exact. Delegates to the shared SessionMessageLoader (single
 * in-flight request per runtime/directory/session, generation-checked
 * commits). Failure leaves the loader's error state intact; the subtree cost
 * stays pending instead of treating the session as free.
 */
const scheduleSubtreeCostLoad = (directory: string, sessionID: string): void => {
    const loader = getImperativeSessionMessageLoader()
    if (!loader) return
    const key = `${getRuntimeKey()}\n${directory}\n${sessionID}`
    if (inFlightCostLoads.has(key)) return
    inFlightCostLoads.add(key)
    void (async () => {
        try {
            const target = { directory, sessionID }
            await loader.ensure(target, { reason: "reactive" })
            const maxPages = getMaxHistoryPages()
            for (let page = 0; page < maxPages; page += 1) {
                const snapshot = loader.getSnapshot(target)
                if (snapshot.status === "error" || snapshot.complete || !snapshot.cursor) break
                await loader.loadOlder(target)
            }
        } catch {
            // The loader records the failure; the pending indicator remains.
        } finally {
            inFlightCostLoads.delete(key)
        }
    })()
}

const isHistoryComplete = (directory: string, sessionID: string): boolean => {
    const loader = getImperativeSessionMessageLoader()
    if (!loader) return true
    const snapshot = loader.getSnapshot({ directory, sessionID })
    // Never fetched through the loader: an existing bucket comes from the live
    // event stream, which delivers every message since session creation.
    if (!snapshot.resolved) return true
    return snapshot.complete
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

const ZERO_SUBTREE_COST: SessionSubtreeCost = {
    sessionCost: 0,
    descendantCost: 0,
    totalCost: 0,
    hasDescendants: false,
    pending: false,
}

type SnapshotCache = {
    rootID: string
    session: State["session"]
    message: State["message"]
    sessionStatus: State["session_status"]
    frozenStamp: number
    result: SessionSubtreeCost
}

const isSameSubtreeCost = (a: SessionSubtreeCost, b: SessionSubtreeCost): boolean =>
    a.sessionCost === b.sessionCost
    && a.descendantCost === b.descendantCost
    && a.totalCost === b.totalCost
    && a.hasDescendants === b.hasDescendants
    && a.pending === b.pending

/**
 * Reactive subtree cost for a session. Subscribes narrowly: notifications
 * fire only when the session tree, a subtree message bucket, or a subtree
 * session status changes — unrelated streaming events do not recompute.
 */
export const useSessionSubtreeCost = (sessionID: string | null, directory?: string): SessionSubtreeCost | null => {
    const syncDirectory = useSyncDirectory()
    const resolvedDirectory = directory ?? syncDirectory
    const store = useDirectoryStore(resolvedDirectory)
    const sessions = useDirectorySync(
        React.useCallback((state: State) => state.session, []),
        resolvedDirectory,
    )

    // Lazy-load descendant histories. Runs again when the tree gains children
    // (state.session reference changes only on structural updates).
    React.useEffect(() => {
        if (!sessionID || !resolvedDirectory) return
        const ids = computeSubtreeIds(sessions, sessionID)
        ids.delete(sessionID)
        for (const id of ids) {
            scheduleSubtreeCostLoad(resolvedDirectory, id)
        }
    }, [sessionID, sessions, resolvedDirectory])

    const cacheRef = React.useRef<SnapshotCache | null>(null)

    const subscribe = React.useCallback((notify: () => void) => {
        if (!sessionID) return () => undefined
        return store.subscribe((state, previous) => {
            if (
                state.session === previous.session
                && state.message === previous.message
                && state.session_status === previous.session_status
            ) {
                return
            }
            if (state.session !== previous.session) {
                notify()
                return
            }
            const ids = computeSubtreeIds(state.session, sessionID)
            for (const id of ids) {
                if (
                    state.message[id] !== previous.message[id]
                    || state.session_status[id] !== previous.session_status[id]
                ) {
                    notify()
                    return
                }
            }
        })
    }, [store, sessionID])

    const getSnapshot = React.useCallback((): SessionSubtreeCost => {
        if (!sessionID) return ZERO_SUBTREE_COST
        const state = store.getState()
        const cache = cacheRef.current
        if (
            cache
            && cache.rootID === sessionID
            && cache.session === state.session
            && cache.message === state.message
            && cache.sessionStatus === state.session_status
            && cache.frozenStamp === frozenVersion
        ) {
            return cache.result
        }
        const computed = computeSubtreeCost(sessionID, {
            sessions: state.session,
            messages: state.message,
            statuses: state.session_status,
            isHistoryComplete: (id) => isHistoryComplete(resolvedDirectory, id),
            readFrozenCost: (id) => readFrozenCost(resolvedDirectory, id),
            writeFrozenCost: (id, cost) => writeFrozenCost(resolvedDirectory, id, cost),
        })
        // Structural sharing: streaming updates that leave the figures
        // unchanged must not re-render consumers.
        const result = cache && isSameSubtreeCost(cache.result, computed) ? cache.result : computed
        cacheRef.current = {
            rootID: sessionID,
            session: state.session,
            message: state.message,
            sessionStatus: state.session_status,
            frozenStamp: frozenVersion,
            result,
        }
        return result
    }, [store, sessionID, resolvedDirectory])

    const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return sessionID ? value : null
}

/**
 * Merge subtree cost into a session-scoped context usage object:
 * `cost` becomes the recursive total (the primary figure shown in the UI),
 * `sessionCost` keeps the current-session-only value for the breakdown.
 */
export const withSubtreeCost = (
    usage: SessionContextUsage | null,
    subtree: SessionSubtreeCost | null,
): SessionContextUsage | null => {
    if (!usage || !subtree) return usage
    return {
        ...usage,
        sessionCost: subtree.sessionCost > 0 ? subtree.sessionCost : undefined,
        cost: subtree.totalCost > 0 ? subtree.totalCost : undefined,
        costPending: subtree.pending || undefined,
    }
}
