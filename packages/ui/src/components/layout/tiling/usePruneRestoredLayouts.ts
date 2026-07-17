import { useEffect, useRef } from "react"

import { opencodeClient } from "@/lib/opencode/client"
import { useUIStore } from "@/stores/useUIStore"
import { classifySessionExistence } from "./classifySessionExistence"
import { pruneRestoredLayout, type SessionTileClassifications } from "./pruneRestoredLayout"

const SESSION_DEDUPE_PREFIX = "session:"

type RestoredSessionTile = {
  readonly sessionId: string
  readonly tileId: string
}

type RestorePruningOptions = {
  readonly enabled: boolean
}

export const usePruneRestoredLayouts = ({
  enabled,
}: RestorePruningOptions): void => {
  const latestRunRef = useRef(0)

  useEffect(() => {
    if (!enabled) return

    let active = true
    const prune = async (): Promise<void> => {
      const run = latestRunRef.current + 1
      latestRunRef.current = run
      const restoredPanels = useUIStore.getState().contextPanelByDirectory
      await Promise.all(Object.entries(restoredPanels).map(async ([directory, panel]) => {
        if (!panel.layout) return

        const sessionTiles: RestoredSessionTile[] = panel.tabs.flatMap((tab) =>
          tab.dedupeKey.startsWith(SESSION_DEDUPE_PREFIX)
            ? [{ sessionId: tab.dedupeKey.slice(SESSION_DEDUPE_PREFIX.length), tileId: tab.id }]
            : [],
        )
        if (sessionTiles.length === 0) return

        const sessionIds = [...new Set(sessionTiles.map((tile) => tile.sessionId))]
        const sessionClassifications = await classifySessionExistence(
          sessionIds,
          async () => (await opencodeClient.listSessions(directory)).map((session) => session.id),
        )
        if (!active || run !== latestRunRef.current) return

        const tileClassifications: Record<string, SessionTileClassifications[string]> = {}
        for (const tile of sessionTiles) {
          tileClassifications[tile.tileId] = sessionClassifications[tile.sessionId]
        }
        const missingTileIds = sessionTiles
          .filter((tile) => tileClassifications[tile.tileId] === "missing")
          .map((tile) => tile.tileId)
        if (missingTileIds.length === 0) return

        const missing = new Set(missingTileIds)
        useUIStore.setState((state) => {
          const current = state.contextPanelByDirectory[directory]
          if (!current?.layout) return state

          const layout = pruneRestoredLayout(current.layout, tileClassifications)
          const tabs = current.tabs.filter((tab) => !missing.has(tab.id))
          const activeTabId = current.activeTabId && tabs.some((tab) => tab.id === current.activeTabId)
            ? current.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null)
          const nextPanel = { ...current, tabs, activeTabId, isOpen: tabs.length > 0 && current.isOpen }
          if (layout) {
            nextPanel.layout = layout
          } else {
            delete nextPanel.layout
          }

          return {
            contextPanelByDirectory: {
              ...state.contextPanelByDirectory,
              [directory]: nextPanel,
            },
          }
        })
      }))
    }
    const run = (): void => {
      void prune()
    }
    const unsubscribe = useUIStore.persist.onFinishHydration(run)
    if (useUIStore.persist.hasHydrated()) run()

    return () => {
      active = false
      latestRunRef.current += 1
      unsubscribe()
    }
  }, [enabled])
}
