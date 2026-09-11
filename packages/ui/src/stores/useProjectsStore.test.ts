import { beforeEach, describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { createProjectIdFromPath } from "@/lib/projectId"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useProjectsStore } from "./useProjectsStore"
import { useDirectoryStore } from "./useDirectoryStore"

const project = (id: string, path: string): ProjectEntry => ({
  id: createProjectIdFromPath(path) ?? id,
  path,
  label: id,
} as ProjectEntry)

describe("useProjectsStore settings synchronization", () => {
  beforeEach(() => {
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null })
    useDirectoryStore.setState({ currentDirectory: "/workspace/current" })
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
  })

  test("treats a successful empty project snapshot as authoritative", () => {
    const existing = project("project-a", "/repo")
    useProjectsStore.setState({
      projects: [existing],
      activeProjectId: existing.id,
      manualProjectOrder: [existing.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test("a reconcile sync never adopts another window's active project", () => {
    // Ids are path-derived inside the store's sanitizer, so seed real ones by
    // bootstrapping once and reading them back.
    const raw = { projects: [{ path: "/repo-a" }, { path: "/repo-b" }] } as DesktopSettings
    useProjectsStore.getState().synchronizeFromSettings(raw)
    const [first, second] = useProjectsStore.getState().projects
    useProjectsStore.setState({ activeProjectId: first.id })

    // The shared settings document carries window B's pointer; outside a
    // bootstrap this window keeps its own.
    useProjectsStore.getState().synchronizeFromSettings(
      { ...raw, activeProjectId: second.id } as DesktopSettings,
      { adoptActiveProject: false },
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(first.id)

    // Unless its own project vanished from the list — then the incoming
    // pointer is better than a dangling one.
    useProjectsStore.getState().synchronizeFromSettings(
      { projects: [{ path: "/repo-b" }], activeProjectId: second.id } as DesktopSettings,
      { adoptActiveProject: false },
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)

    // A bootstrap sync adopts as before.
    useProjectsStore.getState().synchronizeFromSettings(raw)
    useProjectsStore.setState({ activeProjectId: first.id })
    useProjectsStore.getState().synchronizeFromSettings(
      { ...raw, activeProjectId: second.id } as DesktopSettings,
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
  })

  test("keeps the open session directory when a persisted active project changes", () => {
    const sessionDirectory = "/workspace/session"
    useSessionUIStore.setState({ currentSessionId: "ses_open", currentSessionDirectory: sessionDirectory })
    useDirectoryStore.setState({ currentDirectory: sessionDirectory })
    const incoming = project("project-b", "/workspace/project-b")

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [incoming],
      activeProjectId: incoming.id,
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([incoming])
    expect(useProjectsStore.getState().activeProjectId).toBe(incoming.id)
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(sessionDirectory)
    expect(useDirectoryStore.getState().currentDirectory).toBe(sessionDirectory)
  })

  test("applies a persisted active project to the directory when no session is open", () => {
    const incoming = project("project-c", "/workspace/project-c")

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [incoming],
      activeProjectId: incoming.id,
    } as DesktopSettings)

    expect(useProjectsStore.getState().activeProjectId).toBe(incoming.id)
    expect(useDirectoryStore.getState().currentDirectory).toBe(incoming.path)
  })

  test("repeated identical project snapshots are a no-op", () => {
    const incoming = project("project-d", "/workspace/project-d")
    const settings = { projects: [incoming], activeProjectId: incoming.id } as DesktopSettings

    useProjectsStore.getState().synchronizeFromSettings(settings)
    const projectsAfterFirst = useProjectsStore.getState().projects

    useProjectsStore.getState().synchronizeFromSettings(settings)

    expect(useProjectsStore.getState().projects).toBe(projectsAfterFirst)
  })
})

describe("useProjectsStore selection identity", () => {
  test("changes only the active project id", () => {
    const first = { id: "project-a", path: "/repo-a", lastOpenedAt: 10 } as ProjectEntry
    const second = { id: "project-b", path: "/repo-b", lastOpenedAt: 20 } as ProjectEntry
    const projects = [first, second]
    useProjectsStore.setState({
      projects,
      activeProjectId: first.id,
      manualProjectOrder: projects.map((project) => project.id),
    })

    useProjectsStore.getState().setActiveProjectIdOnly(second.id)

    const state = useProjectsStore.getState()
    expect(state.activeProjectId).toBe(second.id)
    expect(state.projects).toBe(projects)
    expect(state.projects.map((project) => project.lastOpenedAt)).toEqual([10, 20])
  })
})

describe("useProjectsStore default model and thinking level", () => {
  const seed = (project: ProjectEntry) => {
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })
  }

  test("keeps a thinking level next to the model it belongs to", () => {
    seed({ id: "project-a", path: "/repo" } as ProjectEntry)

    useProjectsStore.getState().updateProjectMeta("project-a", {
      defaultModel: "anthropic/claude-opus-5",
      defaultVariant: "high",
    })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultModel).toBe("anthropic/claude-opus-5")
    expect(project?.defaultVariant).toBe("high")
  })

  test("drops the thinking level when the model is cleared", () => {
    seed({
      id: "project-a",
      path: "/repo",
      defaultModel: "anthropic/claude-opus-5",
      defaultVariant: "high",
    } as ProjectEntry)

    useProjectsStore.getState().updateProjectMeta("project-a", { defaultModel: null })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultModel).toBe(undefined)
    expect(project?.defaultVariant).toBe(undefined)
  })

  test("ignores a thinking level that arrives without a model", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "project-a", path: "/repo", defaultVariant: "high" }],
    } as DesktopSettings)

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultVariant).toBe(undefined)
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

  test("adds multiple new projects in one update and activates the first", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["/one", "/two", "/three"])

    expect(added).toHaveLength(3)
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two", "/three"])
    expect(useProjectsStore.getState().activeProjectId).toBe(added[0].id)
    expect(added[0].addedAt).toBe(added[1].addedAt)
  })

  test("skips already-added paths and duplicates within the batch", async () => {
    resetProjects()
    await useProjectsStore.getState().addProjects(["/one"])

    const added = await useProjectsStore.getState().addProjects(["/one", "/two", "/two", "/one"])

    expect(added).toHaveLength(1)
    expect(added[0].path).toBe("/two")
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two"])
  })

  test("skips invalid paths and returns an empty array when nothing is addable", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["", "   ", 42 as unknown as string])

    expect(added).toEqual([])
    expect(useProjectsStore.getState().projects).toEqual([])
  })

  test("normalizes paths (trailing separators, backslashes, tilde expansion)", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["/repo/", "C:\\repo", "~/project"])

    const home = useDirectoryStore.getState().homeDirectory;
    expect(added.map((p) => p.path)).toEqual(["/repo", "C:/repo", home ? `${home}/project` : "~/project"])
  })
})
