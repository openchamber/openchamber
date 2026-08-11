import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  SyncProvider,
  useDirectoryStore,
  useSessionBlockingRequestCounts,
} from "./sync-context"

const CountsProbe = ({ includeChild }: { includeChild: boolean }) => {
  const parentStore = useDirectoryStore("/repo", { bootstrap: false })
  const childStore = useDirectoryStore("/worktrees/feature", { bootstrap: false })

  parentStore.setState({ permission: { parent: [{ id: "parent-permission" }] as never[] } })
  childStore.setState({ permission: {
    child: [{ id: "child-permission-1" }, { id: "child-permission-2" }] as never[],
  } })

  const scopes = includeChild
    ? [
        { directory: "/repo", sessionIDs: ["parent"] },
        { directory: "/worktrees/feature", sessionIDs: ["child"] },
      ]
    : [{ directory: "/repo", sessionIDs: ["parent"] }]
  const { permissionCount } = useSessionBlockingRequestCounts(scopes)

  return <output>{permissionCount}</output>
}

const renderPermissionCount = (includeChild: boolean): string => renderToStaticMarkup(
  <SyncProvider sdk={{} as never} directory="/repo">
    <CountsProbe includeChild={includeChild} />
  </SyncProvider>,
)

describe("useSessionBlockingRequestCounts", () => {
  test("rolls a hidden cross-directory subagent permission up to its collapsed parent (#2247)", () => {
    expect(renderPermissionCount(true)).toContain(">3<")
  })

  test("keeps an expanded parent count scoped to the parent row", () => {
    expect(renderPermissionCount(false)).toContain(">1<")
  })
})
