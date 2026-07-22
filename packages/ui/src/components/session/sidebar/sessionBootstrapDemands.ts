import type { DirectoryBootstrapDemand, DirectoryBootstrapPriority } from "@/sync/child-store"
import { normalizePath } from "./utils"

type BootstrapProjectSection = {
  project: { id: string; normalizedPath: string }
  groups: Array<{
    id: string
    directory: string | null
    isArchivedBucket?: boolean
    isMain: boolean
  }>
}

const PRIORITY_RANK: Record<DirectoryBootstrapPriority, number> = {
  selected: 0,
  "active-project": 1,
  expanded: 2,
  visible: 3,
  background: 4,
}

export function buildSessionBootstrapDemands(input: {
  projectSections: BootstrapProjectSection[]
  activeProjectId: string | null
  collapsedProjects: ReadonlySet<string>
  collapsedGroups: ReadonlySet<string>
  currentDirectory: string | null
  currentSessionDirectory: string | null
}): DirectoryBootstrapDemand[] {
  const byDirectory = new Map<string, DirectoryBootstrapDemand>()
  const add = (
    directory: string | null | undefined,
    priority: DirectoryBootstrapPriority,
    reason: DirectoryBootstrapDemand["reason"],
  ) => {
    const normalizedDirectory = normalizePath(directory ?? null)
    if (!normalizedDirectory) return
    const existing = byDirectory.get(normalizedDirectory)
    if (existing && PRIORITY_RANK[existing.priority] <= PRIORITY_RANK[priority]) return
    byDirectory.set(normalizedDirectory, { directory: normalizedDirectory, priority, reason })
  }

  for (const section of input.projectSections) {
    const projectExpanded = !input.collapsedProjects.has(section.project.id)
    let projectPriority: DirectoryBootstrapPriority = "background"
    if (section.project.id === input.activeProjectId) {
      projectPriority = "active-project"
    } else if (projectExpanded) {
      projectPriority = "expanded"
    }
    add(
      section.project.normalizedPath,
      projectPriority,
      projectExpanded ? "project-expanded" : "known-project",
    )

    for (const group of section.groups) {
      if (!group.directory || group.isArchivedBucket || group.isMain) continue
      const groupExpanded = projectExpanded && !input.collapsedGroups.has(`${section.project.id}:${group.id}`)
      let groupPriority: DirectoryBootstrapPriority = "background"
      if (groupExpanded) {
        groupPriority = "expanded"
      } else if (projectExpanded) {
        groupPriority = "visible"
      }
      add(
        group.directory,
        groupPriority,
        groupExpanded ? "worktree-expanded" : "known-worktree",
      )
    }
  }

  add(input.currentDirectory, "selected", "current-directory")
  add(input.currentSessionDirectory, "selected", "selected-session")
  return [...byDirectory.values()]
}
