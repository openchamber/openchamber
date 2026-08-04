import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

import {
  areRequestArraysReferentiallyEqual,
  collectScopedBlockingRequests,
  subscribeScopedPermissionRequests,
} from "./scoped-blocking-requests"
import { ChildStoreManager } from "./child-store"

const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session

describe("scoped blocking requests", () => {
  test("collects requests for the current session subtree", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const siblingRequest = { id: "perm_sibling" }
    const empty: Array<typeof rootRequest> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_root"),
        session("ses_child", "ses_root"),
        session("ses_grandchild", "ses_child"),
        session("ses_sibling"),
      ],
      {
        ses_root: [rootRequest],
        ses_child: [childRequest],
        ses_grandchild: [grandchildRequest],
        ses_sibling: [siblingRequest],
      },
      "ses_root",
      empty,
    )

    expect(result).toEqual([rootRequest, childRequest, grandchildRequest])
  })

  test("aggregates subagent permissions onto the parent when the parent has none (#2247)", () => {
    const childRequest = { id: "perm_child" }
    const siblingRequestA = { id: "perm_sibling_a" }
    const siblingRequestB = { id: "perm_sibling_b" }
    const empty: Array<{ id: string }> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_parent"),
        session("ses_child", "ses_parent"),
        session("ses_sibling", "ses_parent"),
      ],
      {
        // Parent has no pending permission of its own; only the subagents do.
        ses_child: [childRequest],
        ses_sibling: [siblingRequestA, siblingRequestB],
      },
      "ses_parent",
      empty,
    )

    expect(result).toEqual([childRequest, siblingRequestA, siblingRequestB])
  })

  test("assigns hidden branches to their nearest visible ancestor without duplicating visible branches", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const hiddenGrandchildRequest = { id: "perm_hidden_grandchild" }
    const hiddenSiblingRequest = { id: "perm_hidden_sibling" }
    const sessions = [
      session("ses_root"),
      session("ses_child", "ses_root"),
      session("ses_hidden_grandchild", "ses_child"),
      session("ses_hidden_sibling", "ses_root"),
    ]
    const requests = {
      ses_root: [rootRequest],
      ses_child: [childRequest],
      ses_hidden_grandchild: [hiddenGrandchildRequest],
      ses_hidden_sibling: [hiddenSiblingRequest],
    }
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests(sessions, requests, "ses_root", empty))
      .toEqual([rootRequest, childRequest, hiddenSiblingRequest, hiddenGrandchildRequest])
    expect(collectScopedBlockingRequests(
      sessions,
      requests,
      "ses_root",
      empty,
      ["ses_child", "ses_hidden_sibling"],
    )).toEqual([rootRequest])
    expect(collectScopedBlockingRequests(sessions, requests, "ses_root", empty, ["ses_child"]))
      .toEqual([rootRequest, hiddenSiblingRequest])
    expect(collectScopedBlockingRequests(sessions, requests, "ses_child", empty))
      .toEqual([childRequest, hiddenGrandchildRequest])
  })

  test("preserves the parent request as descendants are answered or rejected", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const sessions = [
      session("ses_root"),
      session("ses_child", "ses_root"),
      session("ses_grandchild", "ses_child"),
    ]
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests(sessions, {
      ses_root: [rootRequest],
      ses_child: [childRequest],
      ses_grandchild: [grandchildRequest],
    }, "ses_root", empty)).toEqual([rootRequest, childRequest, grandchildRequest])

    expect(collectScopedBlockingRequests(sessions, {
      ses_root: [rootRequest],
      ses_grandchild: [grandchildRequest],
    }, "ses_root", empty)).toEqual([rootRequest, grandchildRequest])

    expect(collectScopedBlockingRequests(sessions, {
      ses_root: [rootRequest],
    }, "ses_root", empty)).toEqual([rootRequest])
  })

  test("returns the provided empty array when no scoped requests exist", () => {
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests([session("ses_root")], {}, "ses_root", empty)).toBe(empty)
    expect(collectScopedBlockingRequests([session("ses_root")], {}, null, empty)).toBe(empty)
  })

  test("compares request arrays by item identity", () => {
    const first = { id: "perm_1" }
    const second = { id: "perm_2" }

    expect(areRequestArraysReferentiallyEqual([first, second], [first, second])).toBe(true)
    expect(areRequestArraysReferentiallyEqual([first, second], [second, first])).toBe(false)
    expect(areRequestArraysReferentiallyEqual([first], [{ id: "perm_1" }])).toBe(false)
  })

  test("subscribes only to requests owned by the row across streaming and tree transitions", () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/workspace", { bootstrap: false })
    store.setState({
      session: [
        session("ses_root"),
        session("ses_visible_child", "ses_root"),
        session("ses_hidden_child", "ses_root"),
      ],
    })
    let notifications = 0
    const unsubscribe = subscribeScopedPermissionRequests(
      store,
      "ses_root",
      ["ses_visible_child"],
      () => { notifications += 1 },
    )

    for (let index = 0; index < 1_000; index += 1) {
      store.setState({ part: { [`message-${index}`]: [] } })
    }
    store.setState({ permission: { ses_visible_child: [{ id: "visible" }] as never[] } })
    expect(notifications).toBe(0)

    store.setState({ permission: {
      ses_visible_child: [{ id: "visible" }] as never[],
      ses_hidden_child: [{ id: "hidden" }] as never[],
    } })
    expect(notifications).toBe(1)

    store.setState({
      session: [...store.getState().session, session("ses_new_hidden", "ses_root")],
    })
    expect(notifications).toBe(2)
    store.setState({ permission: {
      ...store.getState().permission,
      ses_new_hidden: [{ id: "new-hidden" }] as never[],
    } })
    expect(notifications).toBe(3)

    store.setState({ permission: {
      ses_visible_child: store.getState().permission.ses_visible_child,
      ses_new_hidden: store.getState().permission.ses_new_hidden,
    } })
    expect(notifications).toBe(4)

    store.setState({ permission: {
      ses_visible_child: store.getState().permission.ses_visible_child,
    } })
    expect(notifications).toBe(5)

    unsubscribe()
    manager.disposeAll()
  })

  test("does not wake rows for metadata-only session updates", () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/workspace", { bootstrap: false })
    const sessions = Array.from({ length: 100 }, (_, index) => (
      session(`ses_${index}`, index === 0 ? undefined : `ses_${Math.floor((index - 1) / 2)}`)
    ))
    store.setState({ session: sessions })
    let notifications = 0
    const unsubscribers = sessions.map(({ id }) => subscribeScopedPermissionRequests(
      store,
      id,
      [],
      () => { notifications += 1 },
    ))

    for (let update = 0; update < 1_000; update += 1) {
      store.setState({
        session: store.getState().session.map((current, index) => (
          index === update % sessions.length
            ? { ...current, title: `updated-${update}` }
            : current
        )),
      })
    }

    expect(notifications).toBe(0)
    for (const unsubscribe of unsubscribers) unsubscribe()
    manager.disposeAll()
  })

  test("keeps hierarchy notifications isolated by directory", () => {
    const manager = new ChildStoreManager()
    const first = manager.ensureChild("/first", { bootstrap: false })
    const second = manager.ensureChild("/second", { bootstrap: false })
    first.setState({ session: [session("ses_root")] })
    second.setState({ session: [session("ses_root")] })
    let firstNotifications = 0
    let secondNotifications = 0
    const unsubscribeFirst = subscribeScopedPermissionRequests(first, "ses_root", [], () => {
      firstNotifications += 1
    })
    const unsubscribeSecond = subscribeScopedPermissionRequests(second, "ses_root", [], () => {
      secondNotifications += 1
    })

    first.setState({ session: [...first.getState().session, session("ses_child", "ses_root")] })

    expect(firstNotifications).toBe(1)
    expect(secondNotifications).toBe(0)
    unsubscribeFirst()
    unsubscribeSecond()
    manager.disposeAll()
  })
})
