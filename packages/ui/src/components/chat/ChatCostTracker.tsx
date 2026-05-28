import React from "react"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { Icon } from "@/components/icon/Icon"

export function ChatCostTracker({ sessionId }: { sessionId: string }) {
  const budget = useSessionUIStore((s) => s.sessionBudget.get(sessionId))

  if (!budget) return null
  if (budget.cumulativeCostUsd === 0 && budget.maxBudgetUsd == null) return null

  const label = budget.maxBudgetUsd != null
    ? `Cost: $${budget.cumulativeCostUsd.toFixed(2)} / $${budget.maxBudgetUsd.toFixed(2)}`
    : `Cost: $${budget.cumulativeCostUsd.toFixed(2)}`

  return (
    <div className="flex items-center gap-1 px-4 py-1 text-muted-foreground text-xs">
      <Icon name="donut-chart" className="w-3 h-3" />
      <span>{label}</span>
      {budget.hardCapHit && (
        <span className="text-[var(--status-error)] font-medium ml-1">
          (Budget reached)
        </span>
      )}
      {budget.softCapHit && !budget.hardCapHit && (
        <span className="text-[var(--status-warning)] font-medium ml-1">
          (Near limit)
        </span>
      )}
    </div>
  )
}
