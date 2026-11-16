import { expect, test } from "bun:test"
import { Window } from "happy-dom"

test("changing runtime clears old error details immediately", async () => {
  const dom = new Window({ url: "http://failure-a.test" })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent")
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom })
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.CustomEvent })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.localStorage })
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({ directory: "/fixture", project: { directory: "/fixture" } }) })
  try {
    const { useNotificationStore } = await import("./notification-store")
    const { switchRuntimeEndpoint } = await import("@/lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://failure-a.test", runtimeKey: "failure-a" })
    useNotificationStore.getState().append({ session: "ses_1", time: Date.now() })
    switchRuntimeEndpoint({ apiBaseUrl: "http://failure-b.test", runtimeKey: "failure-b" })
    expect(useNotificationStore.getState().list).toEqual([])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (originalCustomEvent) Object.defineProperty(globalThis, "CustomEvent", originalCustomEvent)
    else Reflect.deleteProperty(globalThis, "CustomEvent")
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch)
    else Reflect.deleteProperty(globalThis, "fetch")
    dom.happyDOM.abort()
  }
})
