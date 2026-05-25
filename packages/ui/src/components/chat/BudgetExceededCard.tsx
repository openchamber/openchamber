import React from "react"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { Icon } from "@/components/icon/Icon"
import { Button } from "@/components/ui/button"

export function BudgetExceededCard({ sessionId }: { sessionId: string }) {
  const budget = useSessionUIStore((s) => s.sessionBudget.get(sessionId))
  const increaseBudget = useSessionUIStore((s) => s.increaseBudget)
  const removeBudgetCap = useSessionUIStore((s) => s.removeBudgetCap)

  if (!budget?.hardCapHit) return null

  return (
    <div className="mx-4 my-2 p-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)]">
      <div className="flex items-center gap-2 mb-2">
        <Icon name="error-warning" className="w-4 h-4 text-[var(--status-error)]" />
        <span className="font-medium text-sm">Budget Reached</span>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Session cost (${budget.cumulativeCostUsd.toFixed(2)}) has reached the set budget of
        ${budget.maxBudgetUsd?.toFixed(2)}. The agent has been paused.
      </p>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" onClick={() => increaseBudget(sessionId, 5)}>
          Increase by $5
        </Button>
        <Button size="sm" onClick={() => increaseBudget(sessionId, 20)}>
          Increase by $20
        </Button>
        <Button size="sm" variant="outline" onClick={() => removeBudgetCap(sessionId)}>
          Remove Cap & Resume
        </Button>
      </div>
    </div>
  )
}
