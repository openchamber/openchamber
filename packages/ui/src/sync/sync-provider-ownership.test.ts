import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8")

describe("sync provider ownership", () => {
  test("keeps provider-local refs out of the original dependency arrays", () => {
    const file = source("./sync-context.tsx")
    const provider = file.slice(file.indexOf("export function SyncProvider("))
    const dependencies = Array.from(provider.matchAll(/^ {2}\}\)?, \[([^\]]*)\]\)$/gm), (match) => (
      match[1] ? match[1].split(",").map((value) => value.trim()) : []
    ))
    // These effects share the provider's stable refs. Extracting them must not
    // change their dependency lists or registration order.
    expect(dependencies).toEqual([
      [],
      ["childStores"],
      ["runtimeKey"],
      [],
      ["props.directory"],
      ["childStores", "props.sdk"],
      ["props.directory"],
      ["childStores", "props.sdk", "runtimeKey"],
      ["childStores", "routingIndex"],
      ["triggerDirectoryResync"],
      ["childStores"],
      ["childStores"],
      ["props.sdk"],
      ["childStores", "messageLoader", "props.sdk", "routingIndex"],
      ["childStores"],
      ["props.sdk"],
      ["props.sdk", "childStores", "messageLoader", "routingIndex", "messageStreamTransport", "runtimeKey", "triggerDirectoryResync"],
      ["childStores", "props.sdk", "triggerDirectoryResync", "runtimeKey"],
      ["props.directory", "childStores", "routingIndex"],
      ["childStores", "messageLoader", "runtimeKey"],
      ["props.sdk", "props.directory", "childStores", "messageLoader", "routingIndex"],
      ["childStores", "messageLoader"],
      ["props.directory", "childStores"],
    ])
  })

  test("installs module observers after dependencies evaluate", () => {
    const file = source("./sync-context.tsx")
    expect(/^import ["']/m.test(file)).toBe(false)
    for (const call of [
      "useWorkflowRunsStore.subscribe(",
      "useGlobalBlockingRequestsStore.subscribe(",
      "setSessionParentResolver(",
      "setHostTurnStartRequester(",
    ]) {
      expect(file).toContain(`\n${call}`)
      expect(file.indexOf(call)).toBeGreaterThan(file.lastIndexOf("\nimport "))
    }
  })

  test("keeps mutable view state private", () => {
    const file = source("./viewed-sessions.ts")
    expect(/^export (?:let|const|var) /m.test(file)).toBe(false)
  })
})
