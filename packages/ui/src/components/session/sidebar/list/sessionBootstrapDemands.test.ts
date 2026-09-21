import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands } from "./sessionBootstrapDemands"

describe("buildSessionBootstrapDemands", () => {
  test("demands only the current directory and the selected session directory", () => {
    const demands = buildSessionBootstrapDemands({
      currentDirectory: "/repo",
      currentSessionDirectory: "/repo/wt-b",
    })

    expect(demands).toEqual([
      { directory: "/repo", priority: "selected", reason: "current-directory" },
      { directory: "/repo/wt-b", priority: "selected", reason: "selected-session" },
    ])
  })

  test("deduplicates one directory selected through both paths", () => {
    const demands = buildSessionBootstrapDemands({
      currentDirectory: "/repo/",
      currentSessionDirectory: "/repo",
    })

    expect(demands.map(({ directory, reason }) => [directory, reason])).toEqual([["/repo", "current-directory"]])
  })

  test("publishes nothing without a working directory", () => {
    expect(buildSessionBootstrapDemands({ currentDirectory: null, currentSessionDirectory: null })).toEqual([])
  })
})
