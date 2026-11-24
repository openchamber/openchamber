import { toast } from "@/components/ui"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import { subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { readSessionCostSettings } from "@/stores/useSessionCostSettingsStore"
import { computeSubtreeCost, formatCost, type SessionTree } from "@/components/chat/work-status/subagentCost"
import {
  sessionCostLevel,
  sessionCostLevelRank,
  type SessionCostLevel,
  type SessionCostThresholds,
} from "@/components/chat/work-status/sessionCostLevel"
import { openSessionFromToast } from "./session-navigation"

type SessionCostCrossing = { rootId: string; level: SessionCostLevel; threshold: number }

const announcedAmounts = new Map<string, number>()

subscribeRuntimeEndpointWillChange(() => announcedAmounts.clear())

const rootOf = (sessionId: string, readSession: SessionTree["readSession"]): string => {
  const visited = new Set<string>()
  let current = sessionId
  while (!visited.has(current)) {
    visited.add(current)
    const parentId = readSession(current)?.parentID
    if (!parentId || !readSession(parentId)) break
    current = parentId
  }
  return current
}

const findSessionCostCrossings = (
  costBefore: ReadonlyMap<string, number>,
  tree: SessionTree,
  thresholds: SessionCostThresholds,
  announcedAmountByRoot: ReadonlyMap<string, number>,
): SessionCostCrossing[] => {
  const rootIds = new Set<string>()
  for (const [sessionId, before] of costBefore) {
    if ((tree.readSession(sessionId)?.cost ?? before) > before) rootIds.add(rootOf(sessionId, tree.readSession))
  }

  const treeBefore: SessionTree = {
    childIdsOf: tree.childIdsOf,
    readSession: (sessionId) => {
      const session = tree.readSession(sessionId)
      const before = costBefore.get(sessionId)
      return session && before !== undefined ? { ...session, cost: before } : session
    },
  }
  const crossings: SessionCostCrossing[] = []
  for (const rootId of rootIds) {
    const level = sessionCostLevel(computeSubtreeCost(rootId, tree), thresholds)
    if (!level) continue
    const levelBefore = sessionCostLevel(computeSubtreeCost(rootId, treeBefore), thresholds)
    if (sessionCostLevelRank(level) <= sessionCostLevelRank(levelBefore)) continue
    const threshold = thresholds[level]
    if ((announcedAmountByRoot.get(rootId) ?? 0) >= threshold) continue
    crossings.push({ rootId, level, threshold })
  }
  return crossings
}

export const noteLiveSessionCosts = (costBefore: ReadonlyMap<string, number>, tree: SessionTree): void => {
  const settings = readSessionCostSettings()
  if (!settings.sessionCostAlertsEnabled || costBefore.size === 0) return
  const thresholds = { warn: settings.sessionCostWarnThreshold, critical: settings.sessionCostCriticalThreshold }
  const crossings = findSessionCostCrossings(costBefore, tree, thresholds, announcedAmounts)
  if (crossings.length === 0) return

  const dictionary = useI18nStore.getState().dictionary
  for (const { rootId, level, threshold } of crossings) {
    announcedAmounts.set(rootId, threshold)
    const session = tree.readSession(rootId)
    const show = level === "critical" ? toast.error : toast.warning
    show(formatMessage(dictionary, "chat.toast.sessionCost.title", { threshold: formatCost(threshold) }), {
      id: `session-cost-${rootId}`,
      description: session?.title || undefined,
      action: session ? {
        label: formatMessage(dictionary, "chat.toast.sessionCost.openSession"),
        onClick: () => openSessionFromToast(rootId, session.directory),
      } : undefined,
    })
  }
}
