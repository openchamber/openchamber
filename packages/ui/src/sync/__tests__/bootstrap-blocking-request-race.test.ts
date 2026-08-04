import { describe, expect, test } from "bun:test"
import type { OpencodeClient, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

import { bootstrapDirectory } from "../bootstrap"
import { INITIAL_STATE, type State } from "../types"

/**
 * `bootstrapDirectory` runs its deferred phase (the one that fetches pending
 * questions/permissions) behind a `setTimeout(..., 0)`, so these tests drive it
 * by awaiting macrotasks after the bootstrap promise settles.
 *
 * The behaviour under test is the same race the resync path guards against in
 * `session-switch-resync.test.ts`: a `question.list` / `permission.list`
 * response that was already in flight when an SSE event mutated the store is
 * stale, and must not overwrite the live state or resurrect a resolved request.
 */

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let index = 0; index < 6; index += 1) {
    await macrotask()
    await Promise.resolve()
  }
}

const question = (id: string, sessionID: string): QuestionRequest =>
  ({ id, sessionID, text: id }) as unknown as QuestionRequest

const permission = (id: string, sessionID: string): PermissionRequest =>
  ({ id, sessionID, type: "edit" }) as unknown as PermissionRequest

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const ok = <T,>(data: T) => Promise.resolve({ data })

const makeHarness = (input: {
  questionList: () => Promise<{ data: QuestionRequest[] }>
  permissionList: () => Promise<{ data: PermissionRequest[] }>
  initial?: Partial<State>
}) => {
  let state: State = { ...INITIAL_STATE, ...input.initial } as State
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch }
  }
  const sdk = {
    project: { current: () => ok({ id: "proj" }) },
    config: { get: () => ok({}) },
    path: { get: () => ok({ directory: "/repo" }) },
    session: { status: () => ok({}) },
    command: { list: () => ok([]) },
    vcs: { get: () => ok(undefined) },
    lsp: { status: () => ok([]) },
    mcp: { status: () => ok({}) },
    question: { list: input.questionList },
    permission: { list: input.permissionList },
  } as unknown as OpencodeClient

  return {
    getState: () => state,
    set,
    run: () =>
      bootstrapDirectory({
        directory: "/repo",
        sdk,
        getState: () => state,
        set,
        global: { config: {}, projects: [] },
        loadSessions: () => undefined,
      }),
  }
}

describe("bootstrapDirectory blocking-request race", () => {
  test("stale non-empty question response cannot overwrite an SSE addition", async () => {
    const pending = deferred<{ data: QuestionRequest[] }>()
    const h = makeHarness({
      questionList: () => pending.promise,
      permissionList: () => ok([]),
      initial: { question: {} },
    })

    const done = h.run()
    await settle()

    // SSE delivers a new question while question.list is still in flight.
    h.set({ question: { s1: [question("q-live", "s1")] } })
    pending.resolve({ data: [] as QuestionRequest[] })

    await done
    await settle()

    expect(h.getState().question.s1?.map((q) => q.id)).toEqual(["q-live"])
  })

  test("stale non-empty question response cannot resurrect an SSE-resolved request", async () => {
    const pending = deferred<{ data: QuestionRequest[] }>()
    const h = makeHarness({
      questionList: () => pending.promise,
      permissionList: () => ok([]),
      initial: { question: { s1: [question("q-old", "s1")] } },
    })

    const done = h.run()
    await settle()

    // SSE resolves the question while the list request is in flight.
    h.set({ question: {} })
    pending.resolve({ data: [question("q-old", "s1")] })

    await done
    await settle()

    expect(h.getState().question.s1).toBe(undefined)
  })

  test("stale non-empty permission response cannot overwrite an SSE addition", async () => {
    const pending = deferred<{ data: PermissionRequest[] }>()
    const h = makeHarness({
      questionList: () => ok([]),
      permissionList: () => pending.promise,
      initial: { permission: {} },
    })

    const done = h.run()
    await settle()

    h.set({ permission: { s1: [permission("p-live", "s1")] } })
    pending.resolve({ data: [] as PermissionRequest[] })

    await done
    await settle()

    expect(h.getState().permission.s1?.map((p) => p.id)).toEqual(["p-live"])
  })

  test("stale non-empty permission response cannot resurrect an SSE-resolved request", async () => {
    const pending = deferred<{ data: PermissionRequest[] }>()
    const h = makeHarness({
      questionList: () => ok([]),
      permissionList: () => pending.promise,
      initial: { permission: { s1: [permission("p-old", "s1")] } },
    })

    const done = h.run()
    await settle()

    h.set({ permission: {} })
    pending.resolve({ data: [permission("p-old", "s1")] })

    await done
    await settle()

    expect(h.getState().permission.s1).toBe(undefined)
  })

  test("still hydrates pending requests when no SSE event intervened", async () => {
    const h = makeHarness({
      questionList: () => ok([question("q1", "s1")]),
      permissionList: () => ok([permission("p1", "s1")]),
      initial: { question: {}, permission: {} },
    })

    await h.run()
    await settle()

    expect(h.getState().question.s1?.map((q) => q.id)).toEqual(["q1"])
    expect(h.getState().permission.s1?.map((p) => p.id)).toEqual(["p1"])
  })

  test("clears a stale entry the server no longer reports when nothing mutated it", async () => {
    const h = makeHarness({
      questionList: () => ok([] as QuestionRequest[]),
      permissionList: () => ok([] as PermissionRequest[]),
      initial: { question: { s1: [question("q-gone", "s1")] } },
    })

    await h.run()
    await settle()

    expect(h.getState().question.s1).toBe(undefined)
  })
})
