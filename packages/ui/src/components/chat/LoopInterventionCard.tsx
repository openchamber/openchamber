import React from "react"
import { useLoopDetectionStore } from "@/stores/loopDetectionStore"
import { Icon } from "@/components/icon/Icon"
import { Button } from "@/components/ui/button"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { DEFAULT_LOOP_DETECTION_CONFIG } from "@/lib/loop-detection/config"

const MAX_AFK_RETRIES = DEFAULT_LOOP_DETECTION_CONFIG.maxAfkRetries

export function LoopInterventionCard({ sessionId }: { sessionId: string }) {
  const resetLoopState = useLoopDetectionStore((s) => s.resetLoopState)
  const lastCleanMessageId = useLoopDetectionStore((s) => s.lastCleanMessageId[sessionId])
  const loopRetryCount = useLoopDetectionStore((s) => s.loopRetryCount[sessionId] ?? 0)
  const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage)

  const handleForceContinue = React.useCallback(async () => {
    const { forceNextStep } = await import("@/sync/session-actions")
    await forceNextStep(sessionId)
    resetLoopState(sessionId)
  }, [sessionId, resetLoopState])

  const handleFork = React.useCallback(async () => {
    const cleanId = lastCleanMessageId
    if (!cleanId) return
    await forkFromMessage(sessionId, cleanId)
    resetLoopState(sessionId)
  }, [sessionId, lastCleanMessageId, forkFromMessage, resetLoopState])

  const handleTerminate = React.useCallback(async () => {
    const { abortCurrentOperation } = await import("@/sync/session-actions")
    await abortCurrentOperation(sessionId)
    resetLoopState(sessionId)
  }, [sessionId, resetLoopState])

  return (
    <div className="mx-4 my-2 p-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)]">
      <div className="flex items-center gap-2 mb-2">
        <Icon name="error-warning" className="w-4 h-4 text-[var(--status-warning)]" />
        <span className="font-medium text-sm">Loop Detected</span>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        The agent appears stuck in a repeating pattern.
        {loopRetryCount > 0 && (
          <span> Auto-retry attempt {loopRetryCount}/{MAX_AFK_RETRIES} used.</span>
        )}
      </p>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" onClick={handleForceContinue}>
          Force Continue
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleFork}
          disabled={!lastCleanMessageId}
        >
          Fork from Last Clean
        </Button>
        <Button size="sm" variant="outline" onClick={handleTerminate}>
          Terminate
        </Button>
      </div>
    </div>
  )
}
