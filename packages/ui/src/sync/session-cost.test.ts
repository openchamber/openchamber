import { describe, expect, test } from "bun:test"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { computeSubtreeCost, withSubtreeCost, type SubtreeCostSource } from "./session-cost"

const session = (id: string, parentID?: string): Session =>
    ({ id, parentID }) as unknown as Session

const assistant = (id: string, cost?: number): Message =>
    ({ id, role: "assistant", cost }) as unknown as Message

const user = (id: string): Message =>
    ({ id, role: "user" }) as unknown as Message

type SourceOverrides = Partial<SubtreeCostSource> & {
    sessions: Session[]
    messages: Record<string, Message[] | undefined>
    statuses?: Record<string, SessionStatus | undefined>
}

const createSource = (overrides: SourceOverrides) => {
    const frozen = new Map<string, number>()
    const source: SubtreeCostSource = {
        statuses: {},
        isHistoryComplete: () => true,
        readFrozenCost: (id) => frozen.get(id),
        writeFrozenCost: (id, cost) => { frozen.set(id, cost) },
        ...overrides,
    }
    return { source, frozen }
}

describe("computeSubtreeCost", () => {
    test("returns the session's own cost when there are no descendants", () => {
        const { source } = createSource({
            sessions: [session("root")],
            messages: { root: [user("u1"), assistant("a1", 0.5), assistant("a2", 0.25)] },
        })
        const result = computeSubtreeCost("root", source)
        expect(result.sessionCost).toBe(0.75)
        expect(result.descendantCost).toBe(0)
        expect(result.totalCost).toBe(0.75)
        expect(result.hasDescendants).toBe(false)
        expect(result.pending).toBe(false)
    })

    test("sums descendant costs recursively", () => {
        const { source } = createSource({
            sessions: [
                session("root"),
                session("child", "root"),
                session("grandchild", "child"),
                session("unrelated"),
            ],
            messages: {
                root: [assistant("a1", 1)],
                child: [assistant("a2", 0.5)],
                grandchild: [assistant("a3", 0.25)],
                unrelated: [assistant("a4", 100)],
            },
        })
        const result = computeSubtreeCost("root", source)
        expect(result.sessionCost).toBe(1)
        expect(result.descendantCost).toBe(0.75)
        expect(result.totalCost).toBe(1.75)
        expect(result.hasDescendants).toBe(true)
        expect(result.pending).toBe(false)
    })

    test("does not double-count on cyclic parent references", () => {
        const { source } = createSource({
            sessions: [session("root", "child"), session("child", "root")],
            messages: { root: [assistant("a1", 1)], child: [assistant("a2", 2)] },
        })
        const result = computeSubtreeCost("root", source)
        expect(result.totalCost).toBe(3)
    })

    test("ignores non-positive or non-finite message costs", () => {
        const { source } = createSource({
            sessions: [session("root")],
            messages: {
                root: [
                    assistant("a1", 0),
                    assistant("a2", -1),
                    assistant("a3", Number.NaN),
                    assistant("a4", undefined),
                    assistant("a5", 0.5),
                ],
            },
        })
        expect(computeSubtreeCost("root", source).totalCost).toBe(0.5)
    })

    test("marks pending and excludes cost for a descendant that was never loaded", () => {
        const { source } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { root: [assistant("a1", 1)] },
        })
        const result = computeSubtreeCost("root", source)
        expect(result.totalCost).toBe(1)
        expect(result.pending).toBe(true)
    })

    test("uses the frozen aggregate for an evicted settled descendant", () => {
        const { source, frozen } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { root: [assistant("a1", 1)] },
        })
        frozen.set("child", 0.75)
        const result = computeSubtreeCost("root", source)
        expect(result.totalCost).toBe(1.75)
        expect(result.pending).toBe(false)
    })

    test("marks pending while a descendant is running, counting its streamed cost", () => {
        const { source } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { root: [assistant("a1", 1)], child: [assistant("a2", 0.5)] },
            statuses: { child: { type: "busy" } as SessionStatus },
        })
        const result = computeSubtreeCost("root", source)
        expect(result.totalCost).toBe(1.5)
        expect(result.pending).toBe(true)
    })

    test("does not freeze the aggregate of a running session", () => {
        const { source, frozen } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { child: [assistant("a2", 0.5)] },
            statuses: { child: { type: "busy" } as SessionStatus },
        })
        computeSubtreeCost("root", source)
        expect(frozen.has("child")).toBe(false)
    })

    test("marks pending when a settled descendant's history is incomplete", () => {
        const { source } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { root: [], child: [assistant("a2", 0.5)] },
            isHistoryComplete: () => false,
        })
        const result = computeSubtreeCost("root", source)
        expect(result.totalCost).toBe(1.5 - 1)
        expect(result.pending).toBe(true)
    })

    test("does not mark pending for the root session alone", () => {
        const { source } = createSource({
            sessions: [session("root")],
            messages: { root: [assistant("a1", 1)] },
            statuses: { root: { type: "busy" } as SessionStatus },
            isHistoryComplete: () => false,
        })
        expect(computeSubtreeCost("root", source).pending).toBe(false)
    })

    test("freezes a settled descendant once its history is complete", () => {
        const { source, frozen } = createSource({
            sessions: [session("root"), session("child", "root")],
            messages: { child: [assistant("a2", 0.5)] },
        })
        computeSubtreeCost("root", source)
        expect(frozen.get("child")).toBe(0.5)
    })
})

describe("withSubtreeCost", () => {
    test("promotes cost to the recursive total and keeps the session cost", () => {
        const usage = { cost: 1, totalTokens: 10, percentage: 5, contextLimit: 100, thresholdLimit: 100 }
        const merged = withSubtreeCost(usage, {
            sessionCost: 1,
            descendantCost: 0.5,
            totalCost: 1.5,
            hasDescendants: true,
            pending: true,
        })
        expect(merged?.cost).toBe(1.5)
        expect(merged?.sessionCost).toBe(1)
        expect(merged?.costPending).toBe(true)
    })

    test("returns the usage unchanged without subtree data", () => {
        const usage = { cost: 1, totalTokens: 10, percentage: 5, contextLimit: 100, thresholdLimit: 100 }
        expect(withSubtreeCost(usage, null)).toBe(usage)
        expect(withSubtreeCost(null, null)).toBe(null)
    })

    test("omits cost fields when nothing was spent", () => {
        const usage = { totalTokens: 10, percentage: 5, contextLimit: 100, thresholdLimit: 100 }
        const merged = withSubtreeCost(usage, {
            sessionCost: 0,
            descendantCost: 0,
            totalCost: 0,
            hasDescendants: false,
            pending: false,
        })
        expect(merged?.cost).toBe(undefined)
        expect(merged?.sessionCost).toBe(undefined)
        expect(merged?.costPending).toBe(undefined)
    })
})
