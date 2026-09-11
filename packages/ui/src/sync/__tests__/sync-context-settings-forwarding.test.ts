import { afterAll, beforeEach, describe, expect, test, mock } from "bun:test"

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: {
    getState: () => ({
      setSessionTodos: () => undefined,
    }),
  },
}))

mock.module("sonner", () => ({
  toast: {
    dismiss: () => undefined,
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

import type { Event as SDKEvent } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"

type TestWindow = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  dispatchEvent: (event: Event) => boolean
}

let createdWindow = false

const getWindow = (): TestWindow => {
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    })
    createdWindow = true
  }
  const testWindow = window as unknown as Partial<TestWindow>
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget()
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget)
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget)
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget)
  }
  return testWindow as TestWindow
}

afterAll(() => {
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window
  }
})

describe("handleEvent openchamber:settings.updated", () => {
  beforeEach(() => {
    getWindow()
  })

  test("forwards the payload as the settings-updated DOM event before directory routing", () => {
    const received: Event[] = []
    const listener = (event: Event) => {
      received.push(event)
    }
    const target = getWindow()
    target.addEventListener("openchamber:settings-updated", listener)

    try {
      handleEvent(
        // A directory + session-addressed shape would otherwise enter the
        // directory routing path; the settings branch must return first.
        "/repo",
        {
          type: "openchamber:settings.updated",
          properties: { sessionID: "ses_1", directory: "/repo" },
        } as unknown as SDKEvent,
        new ChildStoreManager(),
        createEventRoutingIndex(),
        getRuntimeKey(),
      )

      expect(received).toHaveLength(1)
      expect((received[0] as CustomEvent).type).toBe("openchamber:settings-updated")
    } finally {
      target.removeEventListener("openchamber:settings-updated", listener)
    }
  })
})
