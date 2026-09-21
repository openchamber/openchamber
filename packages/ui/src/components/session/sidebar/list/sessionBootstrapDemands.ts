import type { DirectoryBootstrapDemand } from "@/sync/child-store"
import { normalizePath } from "../utils"

// The one bootstrap demand owner (`useSessionListSync`) publishes only the
// directories the user is actually working in. Showing a project, expanding
// it, or restoring its expanded state never initializes it: sidebar rows come
// from the global session list, and live activity comes from the global status
// index, so bootstrapping every known project only made OpenCode create an
// instance per directory at startup.
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
