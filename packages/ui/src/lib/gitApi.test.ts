import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Spy } from "bun:test"
import type { GitAPI, GitStatus } from "./api/types"
import { generateCommitMessage, getGitStatus, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from "./gitApi"
import { switchRuntimeEndpoint } from "./runtime-switch"

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

// Commit-message generation collects diffs for up to 30 selected files. Without
// a bound it issued two requests per file at once, saturating the browser
// connection pool. These tests count real transport calls and the peak number
// in flight at the exported `generateCommitMessage` boundary.
describe("generateCommitMessage diff collection", () => {
  const files = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`)

  let request: Spy<typeof fetch>
  let activeDiffRequests = 0
  let peakDiffRequests = 0
  let diffRequestCount = 0

  const jsonResponse = (body: string): Response =>
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })

  beforeEach(() => {
    activeDiffRequests = 0
    peakDiffRequests = 0
    diffRequestCount = 0
    request = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/api/git/diff")) {
        diffRequestCount += 1
        activeDiffRequests += 1
        peakDiffRequests = Math.max(peakDiffRequests, activeDiffRequests)
        await new Promise((resolve) => setTimeout(resolve, 1))
        activeDiffRequests -= 1
        return jsonResponse(JSON.stringify({
          path: "src/file.ts",
          diff: "--- a/src/file.ts\n+++ b/src/file.ts\n",
          submodule: null,
        }))
      }
      if (url.includes("/api/git/log")) {
        return jsonResponse(JSON.stringify({ all: [], latest: null, total: 0 }))
      }
      if (url.includes("/api/magic-prompts")) {
        return jsonResponse(JSON.stringify({ version: 1, overrides: {} }))
      }
      if (url.includes("/api/small-model/generate")) {
        return jsonResponse(JSON.stringify({ text: '{"subject":"chore: bound diff collection","highlights":[]}' }))
      }
      if (url.includes("/auth/url-token")) {
        return jsonResponse(JSON.stringify({ token: "test-url-token", expiresAt: Date.now() + 60_000 }))
      }
      return jsonResponse("{}")
    })
    switchRuntimeEndpoint({ apiBaseUrl: "https://git.test", runtimeKey: "git-api-commit-diff" })
  })

  afterEach(() => {
    request.mockRestore()
  })

  test("caps diff collection at two selected files in flight", async () => {
    const result = await generateCommitMessage("/repo", files)

    expect(result.message.subject).toBe("chore: bound diff collection")
    expect(diffRequestCount).toBe(files.length * 2)
    // Two files in flight, each issuing a staged + unstaged pair.
    expect(peakDiffRequests).toBeLessThanOrEqual(4)
  })
})
