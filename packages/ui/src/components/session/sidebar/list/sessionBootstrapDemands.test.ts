import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands, filterBackgroundEligibleSections } from "./sessionBootstrapDemands"

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

  test("keeps the complete known topology demanded without a visible section projection", () => {
    const demands = buildSessionBootstrapDemands({
      knownDirectories: ["/repo", "/repo/wt-a", "/repo/wt-b"],
      activeProjectDirectory: "/repo",
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    })

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/repo", "active-project"],
      ["/repo/wt-a", "background"],
      ["/repo/wt-b", "background"],
    ])
  })
})

describe("filterBackgroundEligibleSections", () => {
  test("keeps all sections when background loading is enabled", () => {
    expect(filterBackgroundEligibleSections(sections, null, new Set(["project-a"]))).toBe(sections)
  })

  test("drops collapsed inactive projects but keeps explicitly expanded projects", () => {
    const inactive = { project: { id: "project-b", normalizedPath: "/other" }, groups: [] }
    const expanded = { project: { id: "project-c", normalizedPath: "/expanded" }, groups: [] }

    const filtered = filterBackgroundEligibleSections(
      [...sections, inactive, expanded],
      new Set(["project-c"]),
      new Set(["project-b"]),
    )

    expect(filtered.map((section) => section.project.id)).toEqual(["project-a", "project-c"])
  })

  test("keeps collapsed projects that own an active session", () => {
    const inactive = { project: { id: "project-b", normalizedPath: "/other" }, groups: [] }

    const filtered = filterBackgroundEligibleSections(
      [...sections, inactive],
      new Set(["project-b"]),
      new Set(["project-b"]),
    )

    expect(filtered.map((section) => section.project.id)).toEqual(["project-a", "project-b"])
  })
})
