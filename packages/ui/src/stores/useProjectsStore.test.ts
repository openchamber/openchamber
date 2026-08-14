import { describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"

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

  test("treats legacy generated labels as directory defaults", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "ignored", path: "/workspace/my-project_Name", label: "My Project Name" }],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects[0]?.path).toBe("/workspace/my-project_Name")
    expect(useProjectsStore.getState().projects[0]?.label).toBe(undefined)
  })

  test("preserves a custom label that differs from the legacy generated label", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "ignored", path: "/workspace/my-project", label: "my Custom_Project" }],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects[0]?.label).toBe("my Custom_Project")
  })

  test("removes a custom label when project metadata restores the directory default", () => {
    const project = { id: "project-a", path: "/workspace/my-project", label: "Custom Name" } as ProjectEntry
    useProjectsStore.setState({ projects: [project], activeProjectId: project.id })

    useProjectsStore.getState().updateProjectMeta(project.id, { label: null })

    expect(useProjectsStore.getState().projects[0]?.label).toBe(undefined)
  })
})
