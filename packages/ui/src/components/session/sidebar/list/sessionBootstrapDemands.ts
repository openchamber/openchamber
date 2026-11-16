import type { DirectoryBootstrapDemand } from "@/sync/child-store"
import { normalizePath } from "../utils"

export function buildSessionBootstrapDemands(input: {
  currentDirectory: string | null
  currentSessionDirectory: string | null
}): DirectoryBootstrapDemand[] {
  const demands: DirectoryBootstrapDemand[] = []
  const add = (directory: string | null, reason: DirectoryBootstrapDemand["reason"]) => {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory || demands.some((demand) => demand.directory === normalizedDirectory)) return
    demands.push({ directory: normalizedDirectory, priority: "selected", reason })
  }
  add(input.currentDirectory, "current-directory")
  add(input.currentSessionDirectory, "selected-session")
  return demands
}
