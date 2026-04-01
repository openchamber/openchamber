import { useState, useRef, useEffect, useMemo } from "react"

type StageConfig = {
  /** How many messages to show on first paint */
  init: number
  /** How many to add per animation frame */
  batch: number
}

type UseTimelineStagingInput<T> = {
  /** Key that changes when session switches */
  sessionKey: string
  /** All messages (sorted) */
  messages: T[]
  /** Config for staging behavior */
  config?: StageConfig
}

type UseTimelineStagingResult<T> = {
  /** The subset of messages that should be rendered */
  stagedMessages: T[]
  /** Whether staging is still in progress */
  isStaging: boolean
}

const DEFAULT_CONFIG: StageConfig = { init: 1, batch: 3 }

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 *
 * Defers mounting older turns so first paint isn't blocked by large DOM.
 */
export function useTimelineStaging<T>(
  input: UseTimelineStagingInput<T>,
): UseTimelineStagingResult<T> {
  const config = input.config ?? DEFAULT_CONFIG
  const { sessionKey, messages } = input

  const [stagedCount, setStagedCount] = useState(() => messages.length)
  const completedSessions = useRef(new Set<string>())
  const activeSession = useRef("")
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    // Cancel any pending animation frame
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const total = messages.length

    // If already completed for this session, show all immediately
    if (completedSessions.current.has(sessionKey)) {
      setStagedCount(total)
      return
    }

    // Small message list — no staging needed
    if (total <= config.init) {
      setStagedCount(total)
      completedSessions.current.add(sessionKey)
      return
    }

    // Start staging
    activeSession.current = sessionKey
    let count = Math.min(total, config.init)
    setStagedCount(count)

    const step = () => {
      // Session changed mid-staging — bail
      if (activeSession.current !== sessionKey) {
        frameRef.current = null
        return
      }

      count = Math.min(messages.length, count + config.batch)
      setStagedCount(count)

      if (count >= messages.length) {
        completedSessions.current.add(sessionKey)
        activeSession.current = ""
        frameRef.current = null
        return
      }

      frameRef.current = requestAnimationFrame(step)
    }

    frameRef.current = requestAnimationFrame(step)

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [sessionKey, messages.length, config.init, config.batch])

  const stagedMessages = useMemo(() => {
    if (stagedCount >= messages.length) return messages
    return messages.slice(Math.max(0, messages.length - stagedCount))
  }, [messages, stagedCount])

  const isStaging = activeSession.current === sessionKey &&
    !completedSessions.current.has(sessionKey)

  return { stagedMessages, isStaging }
}
