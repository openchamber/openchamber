import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { GitAPI, GitStatus } from "./api/types"
import { generateCommitMessage, getGitStatus, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from "./gitApi"
import { opencodeClient } from "./opencode/client"
import { configureRuntimeUrlResolver } from "./runtime-url"
import { useAgentsStore, type AgentWithExtras } from "@/stores/useAgentsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useSelectionStore } from "@/sync/selection-store"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const withRuntimeGit = async (git: GitAPI, callback: () => Promise<void>) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENCHAMBER_RUNTIME_APIS__: { git },
    },
  })

  try {
    await callback()
  } finally {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor)
    } else {
      delete (globalThis as { window?: Window }).window
    }
  }
}

describe("getGitStatus", () => {
  test("forwards light-mode options to runtime git APIs", async () => {
    let received: { directory: string; options?: { mode?: "light" } } | null = null
    const runtimeGit = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

describe("git index mutations", () => {
  test("forwards bulk stage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      stageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("forwards bulk unstage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      unstageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("keeps single-file stage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      stageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })

  test("keeps single-file unstage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      unstageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })
})

interface GenerationPromptPayload {
  sessionID?: string
  directory?: string
  model?: { providerID?: string; modelID?: string }
  agent?: string
  variant?: string
  parts?: Array<{ type: string; text: string; synthetic?: boolean }>
}

describe("generateCommitMessage session-fallback agent availability guard", () => {
  const SESSION = "session-git-generation-guard"
  const DIRECTORY = "/projects/git-generation-guard"
  const PROVIDER = "provider-guard"
  const MODEL = "model-guard"
  const AMBIENT_AGENT = "ghost-ambient"

  const previousFetch = globalThis.fetch
  const originalGetApiClient = opencodeClient.getApiClient
  const originalWarn = console.warn
  const originalConfig = {
    currentProviderId: useConfigStore.getState().currentProviderId,
    currentModelId: useConfigStore.getState().currentModelId,
    currentAgentName: useConfigStore.getState().currentAgentName,
  }
  const originalCurrentSessionId = useSessionUIStore.getState().currentSessionId

  const promptPayloads: GenerationPromptPayload[] = []
  const warnings: string[] = []

  const agent = (name: string): AgentWithExtras => ({ name, mode: "subagent", permission: [], options: {} })

  // The prompt path is the only SDK call this file makes; record the request
  // body and answer with one structured completion the parser accepts.
  const sdk = createOpencodeClient({
    baseUrl: "http://git-generation.test",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const text = await request.clone().text()
      promptPayloads.push(JSON.parse(text))
      return Response.json({
        info: { finish: "stop" },
        parts: [{ type: "text", text: JSON.stringify({ subject: "guarded subject", highlights: [] }) }],
      })
    },
  })

  // Small model answers 404 so generation takes the session transport the guard
  // lives on; the remaining git reads may fail without failing the test.
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url
    if (url.includes("/api/small-model/generate")) {
      return Response.json({ error: "No small model" }, { status: 404 })
    }
    if (url.includes("/api/magic-prompts")) {
      return Response.json({ error: "No overrides" }, { status: 404 })
    }
    if (url.includes("/api/git/log")) {
      return Response.json({ all: [], latest: null, total: 0 })
    }
    return Response.json({ error: "git read unavailable" }, { status: 503 })
  }

  beforeEach(() => {
    promptPayloads.length = 0
    warnings.length = 0
    configureRuntimeUrlResolver({ apiBaseUrl: "http://git-generation.test" })
    globalThis.fetch = Object.assign(fetchStub, previousFetch)
    opencodeClient.getApiClient = () => sdk
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warnings.push(`${args[0] ?? ""}`)
    }
    useAgentsStore.setState({ agentsByDirectory: {} })
    useSelectionStore.getState().clearSessionSelections(SESSION)
    useConfigStore.setState({
      currentProviderId: PROVIDER,
      currentModelId: MODEL,
      currentAgentName: AMBIENT_AGENT,
    })
    useSessionUIStore.setState({ currentSessionId: SESSION })
  })

  afterEach(() => {
    configureRuntimeUrlResolver({ apiBaseUrl: "" })
    globalThis.fetch = previousFetch
    opencodeClient.getApiClient = originalGetApiClient
    console.warn = originalWarn
    useConfigStore.setState(originalConfig)
    useSessionUIStore.setState({ currentSessionId: originalCurrentSessionId })
    useAgentsStore.setState({ agentsByDirectory: {} })
    useSelectionStore.getState().clearSessionSelections(SESSION)
  })

  test("drops an agent the send directory does not define and logs it", async () => {
    useAgentsStore.setState({ agentsByDirectory: { [DIRECTORY]: [agent("build")] } })

    const result = await generateCommitMessage(DIRECTORY, ["a.ts"])

    expect(result.message.subject).toBe("guarded subject")
    expect(promptPayloads).toHaveLength(1)
    expect(promptPayloads[0]?.agent).toBeUndefined()
    expect(promptPayloads[0]?.model).toEqual({ providerID: PROVIDER, modelID: MODEL })
    expect(promptPayloads[0]?.parts?.length).toBe(2)
    expect(warnings.some((warning) => warning.includes(AMBIENT_AGENT) && warning.includes(DIRECTORY))).toBe(true)
  })

  test("keeps an available agent unchanged", async () => {
    useAgentsStore.setState({ agentsByDirectory: { [DIRECTORY]: [agent("build")] } })
    useConfigStore.setState({ currentAgentName: "build" })

    await generateCommitMessage(DIRECTORY, ["a.ts"])

    expect(promptPayloads).toHaveLength(1)
    expect(promptPayloads[0]?.agent).toBe("build")
    expect(warnings).toHaveLength(0)
  })

  test("fails open while the directory list has not loaded", async () => {
    await generateCommitMessage(DIRECTORY, ["a.ts"])

    expect(promptPayloads).toHaveLength(1)
    expect(promptPayloads[0]?.agent).toBe(AMBIENT_AGENT)
    expect(warnings).toHaveLength(0)
  })

  test("fails open for an empty directory instead of inventing a scope", async () => {
    useAgentsStore.setState({ agentsByDirectory: { [DIRECTORY]: [agent("build")] } })

    await generateCommitMessage("", ["a.ts"])

    expect(promptPayloads).toHaveLength(1)
    expect(promptPayloads[0]?.agent).toBe(AMBIENT_AGENT)
    expect(warnings).toHaveLength(0)
  })
})
