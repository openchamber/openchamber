/**
 * Recursive session-tree cost aggregation.
 *
 * OpenCode owns `Session.cost`: it is the persisted cost of one session and
 * already accounts for reverted work. OpenChamber only rolls those authoritative
 * per-session values up the parent/child tree.
 */

import * as React from "react"
import type { Session } from "@opencode-ai/sdk/v2"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { useDirectoryStore, useDirectorySync, useSyncDirectory } from "./sync-context"
import type { State } from "./types"

const readSessionCost = (session: Session | undefined): number => {
    const cost = session?.cost
    return typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0
}

export interface SessionSubtreeCost {
    /** OpenCode's authoritative cost for the selected session. */
    sessionCost: number
    /** The selected session plus every descendant session. */
    totalCost: number
}

const ZERO_SUBTREE_COST: SessionSubtreeCost = { sessionCost: 0, totalCost: 0 }

export const computeSubtreeCost = (rootID: string, sessions: Session[]): SessionSubtreeCost => {
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
    let total = 0

    for (const id of computeSubtreeIds(sessions, rootID)) {
        total += readSessionCost(sessionsByID.get(id))
    }

    return { sessionCost: readSessionCost(sessionsByID.get(rootID)), totalCost: total }
}

type SnapshotCache = {
    rootID: string
    sessions: State["session"]
    result: SessionSubtreeCost
}

/**
 * Authoritative cost of a session and all of its descendant sessions.
 *
 * The source is `Session.cost`, persisted by OpenCode. This hook deliberately
 * does not inspect message history, reverts, or local message-loader coverage.
 */
export const useSessionSubtreeCost = (sessionID: string | null, directory?: string): SessionSubtreeCost | null => {
    const syncDirectory = useSyncDirectory()
    const resolvedDirectory = directory ?? syncDirectory
    const store = useDirectoryStore(resolvedDirectory)
    const sessions = useDirectorySync(
        React.useCallback((state: State) => state.session, []),
        resolvedDirectory,
    )
    const cacheRef = React.useRef<SnapshotCache | null>(null)

    const subscribe = React.useCallback((notify: () => void) => {
        if (!sessionID) return () => undefined
        return store.subscribe((state, previous) => {
            if (state.session !== previous.session) notify()
        })
    }, [store, sessionID])

    const getSnapshot = React.useCallback((): SessionSubtreeCost => {
        if (!sessionID) return ZERO_SUBTREE_COST
        const cache = cacheRef.current
        if (cache && cache.rootID === sessionID && cache.sessions === sessions) return cache.result

        const result = computeSubtreeCost(sessionID, sessions)
        cacheRef.current = { rootID: sessionID, sessions, result }
        return result
    }, [sessionID, sessions])

    const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return sessionID ? value : null
}
