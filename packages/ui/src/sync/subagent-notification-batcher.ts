// ---------------------------------------------------------------------------
// Subagent notification batcher
//
// Groups turn-complete / error events from child sessions that share the same
// parent, then emits a single consolidated notification instead of one toast
// per subagent.
// ---------------------------------------------------------------------------

import { appendNotification } from './notification-store'
import type { State } from './types'

export type SubagentEvent = {
  directory: string
  sessionID: string
  parentID: string
  type: 'idle' | 'error'
  error?: { message?: string; code?: string }
  time: number
}

type BatchKey = `${string}:${string}` // directory:parentID

type Batch = {
  directory: string
  parentID: string
  completed: string[]
  errored: SubagentEvent[]
}

const FLUSH_MS = 1200

class SubagentNotificationBatcher {
  private pending = new Map<BatchKey, Batch>()
  private timers = new Map<BatchKey, ReturnType<typeof setTimeout>>()
  private firstSeen = new Map<BatchKey, number>()

  queue(event: SubagentEvent, getState: () => State): void {
    const key: BatchKey = `${event.directory}:${event.parentID}`
    const now = Date.now()

    if (!this.firstSeen.has(key)) {
      this.firstSeen.set(key, now)
    }

    let batch = this.pending.get(key)
    if (!batch) {
      batch = { directory: event.directory, parentID: event.parentID, completed: [], errored: [] }
      this.pending.set(key, batch)
    }

    if (event.type === 'error') {
      batch.errored.push(event)
    } else {
      batch.completed.push(event.sessionID)
    }

    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
    }

    const age = now - (this.firstSeen.get(key) ?? now)
    const remaining = Math.max(0, FLUSH_MS - age)

    this.timers.set(
      key,
      setTimeout(() => this.flush(key, getState), remaining),
    )
  }

  private flush(key: BatchKey, getState: () => State): void {
    const batch = this.pending.get(key)
    if (!batch) return

    this.pending.delete(key)
    this.timers.delete(key)
    this.firstSeen.delete(key)

    const total = batch.completed.length + batch.errored.length
    if (total === 0) return

    const hasError = batch.errored.length > 0
    const representative = hasError ? batch.errored[0] : { sessionID: batch.completed[0] }
    const state = getState()

    let parentSessionID: string | undefined
    let parentMessageID: string | undefined
    let parentPartID: string | undefined

    if (hasError) {
      const subagent = state.session.find((s) => s.id === representative.sessionID)
      const parentID = (subagent as { parentID?: string | null } | undefined)?.parentID
      if (parentID) {
        const parentMessages = state.message[parentID]
        if (Array.isArray(parentMessages)) {
          outer: for (const message of parentMessages) {
            const parts = state.part[message.id]
            if (!Array.isArray(parts)) continue
            for (const part of parts) {
              if (part.type !== 'tool') continue
              const toolPart = part as { tool?: string; output?: unknown }
              if (toolPart.tool !== 'task') continue
              const output = typeof toolPart.output === 'string' ? toolPart.output : ''
              if (output.includes(`<task id="${representative.sessionID}">`) || output.includes(`<task id='${representative.sessionID}'>`)) {
                parentSessionID = parentID
                parentMessageID = message.id
                parentPartID = part.id
                break outer
              }
            }
          }
        }
      }
    }

    appendNotification({
      directory: batch.directory,
      session: representative.sessionID,
      time: Date.now(),
      viewed: false,
      ...(hasError
        ? {
            type: 'error' as const,
            error: {
              message: `${batch.errored.length} subagent${batch.errored.length === 1 ? '' : 's'} failed${batch.completed.length > 0 ? `, ${batch.completed.length} completed` : ''}`,
            },
            ...(parentSessionID ? { parentSessionID, parentMessageID, parentPartID } : {}),
          }
        : {
            type: 'turn-complete' as const,
          }),
    })
  }
}

export const subagentNotificationBatcher = new SubagentNotificationBatcher()
