import { afterEach, expect, test } from "bun:test"
import { opencodeClient } from "./client"
import { getIntegrationClient } from "./integration-catalog"

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
