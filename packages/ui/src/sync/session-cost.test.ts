import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { computeSubtreeCost } from "./session-cost"

const session = (id: string, cost?: number, parentID?: string): Session =>
    ({ id, cost, parentID }) as Session

describe("computeSubtreeCost", () => {
    test("uses OpenCode's persisted cost for a session", () => {
        expect(computeSubtreeCost("root", [session("root", 1.25)])).toEqual({ sessionCost: 1.25, totalCost: 1.25 })
    })

    test("sums descendant session costs recursively", () => {
        const cost = computeSubtreeCost("root", [
            session("root", 1),
            session("child", 0.5, "root"),
            session("grandchild", 0.25, "child"),
            session("unrelated", 100),
        ])

        expect(cost).toEqual({ sessionCost: 1, totalCost: 1.75 })
    })

    test("includes every descendant branch once", () => {
        const cost = computeSubtreeCost("root", [
            session("root", 1),
            session("left", 0.5, "root"),
            session("left-leaf", 0.25, "left"),
            session("right", 2, "root"),
            session("right-leaf", 0.75, "right"),
        ])

        expect(cost).toEqual({ sessionCost: 1, totalCost: 4.5 })
    })

    test("uses the persisted value unchanged for sessions with reverted work", () => {
        const cost = computeSubtreeCost("root", [
            { ...session("root", 1.5), revert: { messageID: "msg_2" } } as Session,
        ])

        expect(cost).toEqual({ sessionCost: 1.5, totalCost: 1.5 })
    })

    test("ignores invalid or non-positive costs", () => {
        expect(computeSubtreeCost("root", [
            session("root", Number.NaN),
            session("child", -1, "root"),
            session("valid", 0.5, "root"),
        ])).toEqual({ sessionCost: 0, totalCost: 0.5 })
    })

    test("does not double-count cyclic parent references", () => {
        expect(computeSubtreeCost("root", [
            session("root", 1, "child"),
            session("child", 2, "root"),
        ])).toEqual({ sessionCost: 1, totalCost: 3 })
    })
})
