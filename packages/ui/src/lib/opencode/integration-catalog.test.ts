import { afterEach, expect, spyOn, test } from "bun:test"
import type { IntegrationInfo } from "@opencode/client"
import { opencodeClient } from "./client"
import { getIntegrationClient, loadIntegrationCatalog } from "./integration-catalog"

afterEach(() => {
  opencodeClient.setDirectory(undefined)
})

// A credential write sent to another location than the list read reaches one
// whose plugins have not activated yet, and OpenCode rejects it as unknown.
test("credential writes go to the location the integration list is read from", () => {
  opencodeClient.setDirectory("/repo/project")
  expect(getIntegrationClient()).toBe(opencodeClient.getScopedSdkClient("/repo/project"))
})

test("a page that names its project writes credentials there, whatever project the chat is in", () => {
  opencodeClient.setDirectory("/repo/chat-project")
  expect(getIntegrationClient("/repo/settings-project")).toBe(opencodeClient.getScopedSdkClient("/repo/settings-project"))
  expect(getIntegrationClient(null)).toBe(opencodeClient.getScopedSdkClient("/repo/chat-project"))
})

test("without a current directory, credential writes stay unscoped like the list read", () => {
  opencodeClient.setDirectory(undefined)
  expect(getIntegrationClient()).toBe(opencodeClient.getSdkClient())
})

// OpenCode 2.4 answers a location nobody opened yet with an empty list until its plugins load.
test("a project OpenCode has not opened yet lists its integrations once its plugins load", async () => {
  const sdk = opencodeClient.getScopedSdkClient("/repo/cold-project")
  const openai: IntegrationInfo = { id: "openai", name: "OpenAI", methods: [], connections: [] }
  let pluginReads = 0
  const loaded = () => pluginReads > 2
  const plugins = spyOn(sdk.plugin, "list").mockImplementation(async () => {
    pluginReads += 1
    return { location: { directory: "/repo/cold-project" }, data: loaded() ? [{ source: { type: "builtin" }, features: {}, state: { status: "active" } }] : [] }
  })
  const list = spyOn(sdk.integration, "list").mockImplementation(async () => (
    { location: { directory: "/repo/cold-project" }, data: loaded() ? [openai] : [] }
  ))
  const websearch = spyOn(sdk.websearch, "providers").mockImplementation(async () => ({ location: { directory: "/repo/cold-project" }, data: [] }))
  try {
    const catalog = await loadIntegrationCatalog("/repo/cold-project")
    expect(catalog.integrations.map((integration) => integration.id)).toEqual(["openai"])
  } finally {
    plugins.mockRestore()
    list.mockRestore()
    websearch.mockRestore()
  }
})
