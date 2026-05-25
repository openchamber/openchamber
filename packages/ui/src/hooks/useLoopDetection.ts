import { useRef, useEffect, useCallback, useMemo } from "react"
import type { Part, ToolPart, Message } from "@opencode-ai/sdk/v2/client"
import { useLoopDetectionStore } from "@/stores/loopDetectionStore"
import { useDirectorySync } from "@/sync/sync-context"
import { useSyncDirectory } from "@/sync/sync-context"
import { LoopDetector } from "@/lib/loop-detection/detector"
import { extractToolCallInput } from "@/lib/loop-detection/types"
import type { LoopPattern } from "@/lib/loop-detection/types"
import type { State } from "@/sync/types"

const FINAL_TOOL_STATUSES = new Set([
  "completed",
  "error",
  "aborted",
  "failed",
  "timeout",
  "cancelled",
])

function isFinalToolStatus(status: string): boolean {
  return FINAL_TOOL_STATUSES.has(status)
}

function getToolStatus(part: Part): string | undefined {
  if (part.type !== "tool") return undefined
  const status = (part as ToolPart).state?.status
  return typeof status === "string" ? status : undefined
}

export function useLoopDetection(sessionId: string | null | undefined) {
  const directory = useSyncDirectory()
  const detectorRef = useRef<LoopDetector | null>(null)
  const processedPartIdsRef = useRef<Set<string>>(new Set())
  const processedReasoningIdsRef = useRef<Set<string>>(new Set())
  const isAfkRunningRef = useRef(false)
  const sessionIdRef = useRef(sessionId)
  const prevLoopDetectedRef = useRef(false)
  sessionIdRef.current = sessionId

  if (!detectorRef.current) {
    detectorRef.current = new LoopDetector()
  }

  const store = useLoopDetectionStore

  useEffect(() => {
    if (!sessionIdRef.current) return
    store.getState().resetLoopState(sessionIdRef.current)
    detectorRef.current?.fullReset()
    processedPartIdsRef.current = new Set()
    processedReasoningIdsRef.current = new Set()
    isAfkRunningRef.current = false
    prevLoopDetectedRef.current = false
  }, [sessionId, store])

  const loopDetectionEnabled = useMemo(
    () => (sessionId ? store.getState().isLoopDetectionEnabled(sessionId) : false),
    [sessionId, store],
  )
  const afkAutoResume = useMemo(
    () => (sessionId ? store.getState().isAfkAutoResumeEnabled(sessionId) : false),
    [sessionId, store],
  )

  const messages: Message[] = useDirectorySync(
    useCallback(
      (state: State) => {
        if (!sessionId) return []
        return state.message[sessionId] ?? []
      },
      [sessionId],
    ),
    directory,
  )

  const latestAssistantMessageId = useMemo(() => {
    if (!messages || messages.length === 0) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant") return m.id
    }
    return null
  }, [messages])

  const parts: Part[] = useDirectorySync(
    useCallback(
      (state: State) => {
        if (!latestAssistantMessageId) return []
        return state.part[latestAssistantMessageId] ?? []
      },
      [latestAssistantMessageId],
    ),
    directory,
  )

  const latestUserMessageId = useMemo(() => {
    if (!messages || messages.length === 0) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "user") return m.id
    }
    return null
  }, [messages])

  const loopDetected = useMemo(
    () => (sessionId ? store.getState().isLoopDetected(sessionId) : false),
    [sessionId, store],
  )
  const loopRetryCount = useMemo(
    () => (sessionId ? store.getState().loopRetryCount[sessionId] ?? 0 : 0),
    [sessionId, store],
  )

  const maxRetries = 3

  useEffect(() => {
    if (!sessionId || !loopDetectionEnabled || !detectorRef.current) return

    const detector = detectorRef.current

    if (latestUserMessageId && !processedPartIdsRef.current.has(`user:${latestUserMessageId}`)) {
      processedPartIdsRef.current.add(`user:${latestUserMessageId}`)
      detector.recordUserMessage(latestUserMessageId)
      store.getState().resetLoopState(sessionId)
      processedPartIdsRef.current = new Set()
      processedReasoningIdsRef.current = new Set()
      isAfkRunningRef.current = false
      prevLoopDetectedRef.current = false
      return
    }

    if (!parts || parts.length === 0) return

    for (const part of parts) {
      if (part.type === "tool") {
        const partId = part.id
        if (processedPartIdsRef.current.has(partId)) continue

        const status = getToolStatus(part)
        if (!status || !isFinalToolStatus(status)) continue

        processedPartIdsRef.current.add(partId)
        const input = extractToolCallInput(part as ToolPart)
        if (!input) continue

        detector.recordToolCall(sessionId, input)
      } else if (part.type === "reasoning") {
        const partId = part.id
        if (processedReasoningIdsRef.current.has(partId)) continue

        processedReasoningIdsRef.current.add(partId)
        const text = (part as Record<string, unknown>).text as string
        if (!text) continue

        detector.recordReasoning(sessionId, text, (part as Record<string, unknown>).messageID as string)
      }
    }

    const snapshot = detector.getSnapshot()
    const prevDetected = prevLoopDetectedRef.current

    if (snapshot.loopDetected !== prevDetected) {
      prevLoopDetectedRef.current = snapshot.loopDetected
      store.getState().setLoopDetected(
        sessionId,
        snapshot.loopDetected,
        snapshot.lastCleanMessageId,
        snapshot.detectedPattern,
      )
    }

    if (afkAutoResume && !isAfkRunningRef.current && snapshot.loopDetected) {
      const retryCount = store.getState().loopRetryCount[sessionId] ?? 0
      if (retryCount < maxRetries) {
        isAfkRunningRef.current = true
        store.getState().incrementRetryCount(sessionId)
        prevLoopDetectedRef.current = false
        detector.reset()

        import("@/sync/session-actions").then(({ forceNextStep }) => {
          forceNextStep(sessionId).finally(() => {
            isAfkRunningRef.current = false
          })
        })
      }
    }
  }, [sessionId, loopDetectionEnabled, afkAutoResume, parts, latestUserMessageId, latestAssistantMessageId, maxRetries, store])

  const isAfkActive = afkAutoResume && loopDetected && loopRetryCount < maxRetries
  const showIntervention = loopDetectionEnabled && (!afkAutoResume || (loopDetected && loopRetryCount >= maxRetries))

  return {
    loopDetected: loopDetectionEnabled ? loopDetected : false,
    loopRetryCount,
    lastCleanMessageId: sessionId ? store.getState().lastCleanMessageId[sessionId] : undefined,
    loopPattern: sessionId ? store.getState().loopPattern[sessionId] ?? null : null as LoopPattern | null,
    isAfkActive,
    showIntervention,
  }
}
