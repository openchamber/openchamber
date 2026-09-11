import { describe, expect, mock, test } from "bun:test"
import type { FilesAPI, GitAPI, GitCommitChangedFile, GitLogResponse, GitStatus, RuntimeAPIs } from "./api/types"
import { createGitTag, generatePullRequestDescription, getGitHistory, getGitHistoryMergeBase, getGitHistoryRefs, getGitStatus, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from "./gitApi"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const previousFetch = globalThis.fetch

type RuntimeAPIFixture = Partial<Omit<RuntimeAPIs, "git" | "files">> & {
  git?: Partial<GitAPI>
  files?: Pick<FilesAPI, "readFile">
}

const withRuntimeAPIs = async (
  apis: RuntimeAPIFixture,
  callback: () => Promise<void>,
) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/",
      },
      __OPENCHAMBER_RUNTIME_APIS__: apis,
    },
  })

  try {
    await callback()
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
}

const withRuntimeGit = async (git: Partial<GitAPI>, callback: () => Promise<void>) => {
  await withRuntimeAPIs({ git }, callback)
}

describe("getGitStatus", () => {
  test("forwards light-mode options to runtime git APIs", async () => {
    let received: { directory: string; options?: { mode?: "light" } } | null = null
    const runtimeGit = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    }

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

describe("git history runtime dispatch", () => {
  test("forwards history requests to runtime git APIs", async () => {
    const calls: Array<unknown> = []
    const runtimeGit = {
      getGitHistoryRefs: async (directory: string) => {
        calls.push(["refs", directory])
        return { refs: [], current: null, upstream: null, base: null, snapshot: "snap" }
      },
      getGitHistory: async (directory: string, options: { refs: string[]; cursor?: string; limit?: number }) => {
        calls.push(["history", directory, options])
        return { items: [], nextCursor: null, hasMore: false, refsSnapshot: "snap" }
      },
      getGitHistoryMergeBase: async (directory: string, options: { refs: string[] }) => {
        calls.push(["merge-base", directory, options])
        return { mergeBase: null }
      },
    }

    await withRuntimeGit(runtimeGit, async () => {
      await getGitHistoryRefs("/repo")
      await getGitHistory("/repo", { refs: ["HEAD"], limit: 10 })
      await getGitHistoryMergeBase("/repo", { refs: ["HEAD", "refs/heads/main"] })
    })

    expect(calls).toEqual([
      ["refs", "/repo"],
      ["history", "/repo", { refs: ["HEAD"], limit: 10 }],
      ["merge-base", "/repo", { refs: ["HEAD", "refs/heads/main"] }],
    ])
  })
})

describe("git index mutations", () => {
  test("forwards create tag requests to runtime git APIs when available", async () => {
    let received: { directory: string; name: string; commitHash: string } | null = null
    const runtimeGit = {
      createGitTag: async (directory: string, name: string, commitHash: string) => {
        received = { directory, name, commitHash }
        return { success: true, tag: name }
      },
    }

    await withRuntimeGit(runtimeGit, async () => {
      await createGitTag("/repo", "v1.2.3", "0123456789abcdef0123456789abcdef01234567")
    })

    expect(received).toEqual({
      directory: "/repo",
      name: "v1.2.3",
      commitHash: "0123456789abcdef0123456789abcdef01234567",
    })
  })

  test("forwards bulk stage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      stageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    }

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
    }

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
    }

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
    }

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })
})

describe("generatePullRequestDescription", () => {
  test("uses the first parent for normal and merge commits, and null for root commits", async () => {
    const normalHash = "1111111111111111111111111111111111111111"
    const normalParent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const mergeHash = "2222222222222222222222222222222222222222"
    const mergeFirstParent = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const mergeSecondParent = "cccccccccccccccccccccccccccccccccccccccc"
    const rootHash = "3333333333333333333333333333333333333333"
    const commitFileRequests: Array<[string, string | null]> = []
    const readPaths: string[] = []
    const commitFiles: GitCommitChangedFile[] = [{
      path: `${normalHash}.ts`,
      status: "M",
      kind: "file",
      insertions: 1,
      deletions: 0,
      isBinary: false,
    }]
    const runtimeGit: Partial<GitAPI> = {
      getGitLog: async (): Promise<GitLogResponse> => ({
        all: [
          { hash: normalHash, parents: [normalParent], message: "normal", body: "", author_name: "", author_email: "", date: "", refs: "", filesChanged: 0, insertions: 0, deletions: 0 },
          { hash: mergeHash, parents: [mergeFirstParent, mergeSecondParent], message: "merge", body: "", author_name: "", author_email: "", date: "", refs: "", filesChanged: 0, insertions: 0, deletions: 0 },
          { hash: rootHash, parents: [], message: "root", body: "", author_name: "", author_email: "", date: "", refs: "", filesChanged: 0, insertions: 0, deletions: 0 },
        ],
        latest: null,
        total: 3,
      }),
      getCommitFiles: async (_directory: string, request: { commitHash: string; parentHash: string | null }) => {
        commitFileRequests.push([request.commitHash, request.parentHash])
        return {
          files: commitFiles.map((file) => ({
            ...file,
            path: `${request.commitHash}.ts`,
          })),
        }
      },
    }
    const readFile: NonNullable<FilesAPI["readFile"]> = async (path) => {
      readPaths.push(path)
      return { content: "", path }
    }

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "/api/magic-prompts") {
        return new Response(JSON.stringify({ version: 1, overrides: {} }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url === "/api/small-model/generate") {
        return new Response(JSON.stringify({ text: JSON.stringify({ title: "PR title", body: "PR body" }) }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await withRuntimeAPIs({ git: runtimeGit, files: { readFile } }, async () => {
      const result = await generatePullRequestDescription("/repo", {
        base: "main",
        head: "feature",
      })

      expect(result).toEqual({ title: "PR title", body: "PR body" })
    })

    expect(readPaths).toEqual([
      "/repo/.github/pull_request_template.md",
      "/repo/.github/PULL_REQUEST_TEMPLATE.md",
      "/repo/pull_request_template.md",
      "/repo/PULL_REQUEST_TEMPLATE.md",
      "/repo/docs/pull_request_template.md",
      "/repo/docs/PULL_REQUEST_TEMPLATE.md",
      "/repo/.gitlab/merge_request_templates/Default.md",
    ])
    expect(commitFileRequests.sort()).toEqual([
      [normalHash, normalParent],
      [mergeHash, mergeFirstParent],
      [rootHash, null],
    ].sort())
  })
})
