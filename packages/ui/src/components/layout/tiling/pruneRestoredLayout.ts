import { pruneMissingLeaves, type PanelLayout } from "./splitTree"

export type SessionTileClassification = "present" | "missing" | "unknown-fetch-failed"
export type SessionTileClassifications = Readonly<Record<string, SessionTileClassification>>

const shouldPrune = (classification: SessionTileClassification): boolean => {
  switch (classification) {
    case "missing":
      return true
    case "present":
    case "unknown-fetch-failed":
      return false
    default:
      return classification satisfies never
  }
}

export const pruneRestoredLayout = (
  layout: PanelLayout,
  classifications: SessionTileClassifications,
): PanelLayout | null => {
  const missingTileIds = Object.entries(classifications)
    .filter(([, classification]) => shouldPrune(classification))
    .map(([tileId]) => tileId)

  return missingTileIds.length === 0 ? layout : pruneMissingLeaves(layout, missingTileIds)
}
