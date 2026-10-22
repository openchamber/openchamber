import { describe, expect, test } from "bun:test"
import type { ProjectEntry, RuntimeAPIs, SourceControlAPI, SourceControlAuthStatus, SourceControlBindingRead, SourceControlIdentity } from "@/lib/api/types"
import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { useSourceControlAuthStore } from "./useSourceControlAuthStore"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"
import { useDirectoryStore } from "./useDirectoryStore"
import { opencodeClient } from "../lib/opencode/client"

describe("useProjectsStore settings synchronization", () => {
  test("preserves drive roots and deduplicates Windows drive/separator variants", () => {
    const previous = useProjectsStore.getState()
    const directoryState = useDirectoryStore.getState()
    const sdkDirectory = opencodeClient.getDirectory()
    try {
      useProjectsStore.getState().synchronizeFromSettings({ projects: [
        { id: "drive", path: "c:\\" },
        { id: "lower", path: "c:\\Users\\Developer\\Project\\" },
        { id: "upper", path: "C:/Users/Developer/Project" },
      ] })
      expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(["C:/", "C:/Users/Developer/Project"])
    } finally {
      useProjectsStore.setState(previous, true)
      useDirectoryStore.setState(directoryState, true)
      opencodeClient.setDirectory(sdkDirectory)
    }
  })

  test("directory navigation preserves roots and does not create history duplicates for Windows spelling variants", () => {
    const previous = useDirectoryStore.getState()
    const sdkDirectory = opencodeClient.getDirectory()
    try {
      useDirectoryStore.setState({ homeDirectory: "/home", currentDirectory: "/home", directoryHistory: ["/home"], historyIndex: 0 })
      useDirectoryStore.getState().setDirectory("c:\\Project")
      useDirectoryStore.getState().setDirectory("C:/Project/")
      expect(useDirectoryStore.getState().directoryHistory).toEqual(["/home", "C:/Project"])
      useDirectoryStore.setState({ directoryHistory: ["/home", "C:/Project", "C:/Other"], historyIndex: 1 })
      useDirectoryStore.getState().setDirectory("c:\\Project\\")
      expect(useDirectoryStore.getState().historyIndex).toBe(1)
      expect(useDirectoryStore.getState().directoryHistory).toEqual(["/home", "C:/Project", "C:/Other"])
      useDirectoryStore.getState().goToParent()
      expect(useDirectoryStore.getState().currentDirectory).toBe("C:/")
      expect(opencodeClient.getDirectory()).toBe("C:/")
      useDirectoryStore.getState().goToParent()
      expect(useDirectoryStore.getState().currentDirectory).toBe("C:/")
      useDirectoryStore.getState().setDirectory("\\\\Server\\Share\\Folder")
      useDirectoryStore.getState().goToParent()
      useDirectoryStore.getState().goToParent()
      expect(useDirectoryStore.getState().currentDirectory).toBe("//Server/Share")
    } finally {
      useDirectoryStore.setState(previous, true)
      opencodeClient.setDirectory(sdkDirectory)
    }
  })

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

  test("persists and clears a project default agent", () => {
    seed({ id: "project-a", path: "/repo" })

    useProjectsStore.getState().updateProjectMeta("project-a", { defaultAgent: "plan" })
    expect(useProjectsStore.getState().projects[0]?.defaultAgent).toBe("plan")

    useProjectsStore.getState().updateProjectMeta("project-a", { defaultAgent: "   " })
    expect(useProjectsStore.getState().projects[0]?.defaultAgent).toBe(undefined)
  })

  test("sanitizes a project default agent from settings", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "project-a", path: "/repo", defaultAgent: "  plan  " }],
    })

    expect(useProjectsStore.getState().projects[0]?.defaultAgent).toBe("plan")
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

describe("useProjectsStore.fetchGitLabProjectIcon", () => {
  test("keeps an icon the project already has without asking GitLab", async () => {
    const previous = useProjectsStore.getState()
    try {
      const project: ProjectEntry = { id: "project-a", path: "/repo", label: "Repo", iconImage: { mime: "image/png", updatedAt: 1, source: "auto" } }
      useProjectsStore.setState({ projects: [project], activeProjectId: project.id, manualProjectOrder: [project.id] })

      expect(await useProjectsStore.getState().fetchGitLabProjectIcon(project.id)).toEqual({ ok: true, skipped: true })
    } finally {
      useProjectsStore.setState(previous, true)
    }
  })
})

class StubFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(buffer)))}`
      this.onload?.()
    }, () => this.onerror?.())
  }
}

describe("useProjectsStore.fetchGitLabProjectIcon with a GitLab remote", () => {
  const instance = "https://gitlab.example.com"
  const identity = { provider: "gitlab", instance } satisfies SourceControlIdentity
  const user = { ...identity, id: "user-one", username: "owner" }
  const status: SourceControlAuthStatus = {
    ...identity,
    status: "connected",
    connected: true,
    user,
    accounts: [{
      id: "account-one", credentialId: "account-one", credentialRevision: 1, providerUserId: "user-one",
      providerUserStatus: "available", user, current: true, source: "pat", status: "valid",
    }],
  }
  const remote = { displayUrl: `${instance}/team/repo`, fingerprint: "fetch" }
  const bindingRead: SourceControlBindingRead = {
    status: "missing",
    repository: { repositoryId: "repo-one", configRevision: "config", bare: false, remotes: [{ name: "origin", fetch: remote, push: remote }] },
    revision: 2,
    binding: null,
  }
  const project: ProjectEntry = { id: "project-a", path: "/repo", label: "Repo" }

  const run = async (avatar: Response) => {
    const previous = useProjectsStore.getState()
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")
    const originalFileReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader")
    Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: StubFileReader })
    const calls: Array<{ url: URL; method: string }> = []
    const sourceControl: Pick<SourceControlAPI, "authInstances" | "authStatus" | "repositoryBinding"> = {
      authInstances: async () => [identity],
      authStatus: async () => status,
      repositoryBinding: async () => bindingRead,
    }
    // SAFETY: the store reads only authInstances, authStatus and repositoryBinding from the registered source control API.
    registerRuntimeAPIs({ sourceControl } as RuntimeAPIs)
    useSourceControlAuthStore.getState().resetForRuntimeSwitch()
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost")
        calls.push({ url, method: init?.method ?? "GET" })
        if (url.pathname === "/api/source-control/gitlab/repo/avatar") return avatar
        return Response.json({ settings: { projects: [{ ...project, iconImage: { mime: "image/png", updatedAt: 1, source: "custom" }, addedAt: 1, lastOpenedAt: 1 }] } })
      },
    })
    try {
      useProjectsStore.setState({ projects: [project], activeProjectId: project.id, manualProjectOrder: [project.id] })
      const result = await useProjectsStore.getState().fetchGitLabProjectIcon(project.id)
      return { result, calls, projects: useProjectsStore.getState().projects }
    } finally {
      useProjectsStore.setState(previous, true)
      registerRuntimeAPIs(null)
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch)
      if (originalFileReader) Object.defineProperty(globalThis, "FileReader", originalFileReader)
      else Reflect.deleteProperty(globalThis, "FileReader")
    }
  }

  test("reads the avatar with the current account and saves it as the project's icon", async () => {
    const { result, calls, projects } = await run(new Response("png", { headers: { "content-type": "image/png" } }))

    expect(result).toEqual({ ok: true })
    const avatarCall = calls.find((call) => call.url.pathname === "/api/source-control/gitlab/repo/avatar")
    expect(avatarCall?.url.searchParams.get("instance")).toBe(instance)
    expect(avatarCall?.url.searchParams.get("accountId")).toBe("account-one")
    expect(avatarCall?.url.searchParams.get("directory")).toBe("/repo")
    expect(calls.some((call) => call.url.pathname === "/api/projects/project-a/icon" && call.method === "PUT")).toBe(true)
    expect(projects[0]?.iconImage?.mime).toBe("image/png")
  })

  test("leaves the project without an icon when GitLab has no avatar for it", async () => {
    const { result, calls, projects } = await run(new Response("{}", { status: 404 }))

    expect(result).toEqual({ ok: true, skipped: true })
    expect(calls.some((call) => call.method === "PUT")).toBe(false)
    expect(projects[0]?.iconImage).toBeUndefined()
  })
})
