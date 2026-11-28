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

test("a stateless backend has an empty catalog without a native integration endpoint", async () => {
  const directory = "/repo/stateless-project"
  const sdk = opencodeClient.getScopedSdkClient(directory)
  const location = { directory }
  const plugins = spyOn(sdk.plugin, "list").mockResolvedValue({ location, data: [] })
  const inventory = spyOn(sdk.debug.location, "list").mockResolvedValue([])
  const integrations = spyOn(sdk.integration, "list").mockRejectedValue(new Error("No integration endpoint"))
  const websearch = spyOn(sdk.websearch, "providers").mockResolvedValue({ location, data: [] })
  try {
    expect((await loadIntegrationCatalog(directory)).integrations).toEqual([])
    expect(integrations).not.toHaveBeenCalled()
  } finally {
    plugins.mockRestore()
    inventory.mockRestore()
    integrations.mockRestore()
    websearch.mockRestore()
  }
}, 8_000)

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
  const inventory = spyOn(sdk.debug.location, "list").mockRejectedValue(new Error("Inventory unavailable"))
  const list = spyOn(sdk.integration, "list").mockImplementation(async () => (
    { location: { directory: "/repo/cold-project" }, data: loaded() ? [openai] : [] }
  ))
  const websearch = spyOn(sdk.websearch, "providers").mockImplementation(async () => ({ location: { directory: "/repo/cold-project" }, data: [] }))
  try {
    const catalog = await loadIntegrationCatalog("/repo/cold-project")
    expect(catalog.integrations.map((integration) => integration.id)).toEqual(["openai"])
  } finally {
    plugins.mockRestore()
    inventory.mockRestore()
    list.mockRestore()
    websearch.mockRestore()
  }
})
