import { describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"
import { useDirectoryStore } from "./useDirectoryStore"

describe("useProjectsStore settings synchronization", () => {
  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })
})

describe("useProjectsStore.addProjects", () => {
  const resetProjects = () => {
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
      manualProjectOrder: [],
    })
  }

  test("adds multiple new projects in one update and activates the first", () => {
    resetProjects()

    const added = useProjectsStore.getState().addProjects(["/one", "/two", "/three"])

    expect(added).toHaveLength(3)
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two", "/three"])
    expect(useProjectsStore.getState().activeProjectId).toBe(added[0].id)
    expect(added[0].addedAt).toBe(added[1].addedAt)
  })

  test("skips already-added paths and duplicates within the batch", () => {
    resetProjects()
    useProjectsStore.getState().addProjects(["/one"])

    const added = useProjectsStore.getState().addProjects(["/one", "/two", "/two", "/one"])

    expect(added).toHaveLength(1)
    expect(added[0].path).toBe("/two")
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two"])
  })

  test("skips invalid paths and returns an empty array when nothing is addable", () => {
    resetProjects()

    const added = useProjectsStore.getState().addProjects(["", "   ", 42 as unknown as string])

    expect(added).toEqual([])
    expect(useProjectsStore.getState().projects).toEqual([])
  })

  test("normalizes paths (trailing separators, backslashes, tilde expansion)", () => {
    resetProjects()

    const added = useProjectsStore.getState().addProjects(["/repo/", "C:\\repo", "~/project"])

    const home = useDirectoryStore.getState().homeDirectory;
    expect(added.map((p) => p.path)).toEqual(["/repo", "C:/repo", home ? `${home}/project` : "~/project"])
  })
})
