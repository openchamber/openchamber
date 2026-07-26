import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands } from "./sessionBootstrapDemands"

const sections = [{
  project: { id: "project-a", normalizedPath: "/repo" },
  groups: [
    { id: "root", directory: "/repo", isMain: true },
    { id: "worktree:/repo/wt-a", directory: "/repo/wt-a", isMain: false },
    { id: "worktree:/repo/wt-b", directory: "/repo/wt-b", isMain: false },
  ],
}]

describe("buildSessionBootstrapDemands", () => {
  test("keeps collapsed worktrees eligible at background priority", () => {
    const demands = buildSessionBootstrapDemands({
      projectSections: sections,
      activeProjectId: null,
      collapsedProjects: new Set(["project-a"]),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    })

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/repo", "background"],
      ["/repo/wt-a", "background"],
      ["/repo/wt-b", "background"],
    ])
  })

  test("promotes expansion and selected session without duplicate directories", () => {
    const demands = buildSessionBootstrapDemands({
      projectSections: sections,
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      collapsedGroups: new Set(["project-a:worktree:/repo/wt-b"]),
      currentDirectory: "/repo",
      currentSessionDirectory: "/repo/wt-b",
    })
    const byDirectory = new Map(demands.map((demand) => [demand.directory, demand]))

    expect(demands.length).toBe(3)
    expect(byDirectory.get("/repo")?.priority).toBe("selected")
    expect(byDirectory.get("/repo/wt-a")?.priority).toBe("expanded")
    expect(byDirectory.get("/repo/wt-b")?.priority).toBe("selected")
  })
})
