/**
 * Reproduction test for issue #2340: "Cannot connect to API: Unable to connect.
 * Is the computer able to access the url?"
 *
 * The error message comes from the OpenCode backend when it cannot reach the AI
 * provider's API. OpenChamber relays it through the SSE/WebSocket event pipeline
 * and displays it as a retry overlay.
 *
 * This test verifies:
 * 1. The session status snapshot correctly stores and retrieves retry status
 *    with the "Cannot connect to API" message.
 * 2. The retry status structure is correctly preserved through snapshot updates.
 * 3. The message format is compatible with the downstream consumers.
 */

import { describe, expect, test } from "bun:test";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { applySessionStatusSnapshot } from "../sync-context";
import { create, type StoreApi } from "zustand";
import { INITIAL_STATE } from "../types";
import type { DirectoryStore } from "../child-store";

// --------------- Test helpers ---------------

function createDirectoryStore(initial?: Partial<Record<string, unknown>>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: [],
    patch: (partial: unknown) => set(partial as Partial<DirectoryStore>),
    replace: (next: unknown) => set(next as DirectoryStore),
  })) as unknown as StoreApi<DirectoryStore>;
}

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>;

// --------------- Tests ---------------

describe("issue #2340: Cannot connect to API retry message", () => {
  test("session status snapshot preserves the full retry message", () => {
    const store = createDirectoryStore({ session_status: {} });

    const retryStatus: SessionStatus = {
      type: "retry",
      attempt: 2,
      message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      next: 30000,
    };

    const changed = applySessionStatusSnapshot(
      store as unknown as StoreApi<DirectoryStore>,
      { ses_1: { type: "retry", attempt: 2, message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?", next: 30000 } },
      ["ses_1"],
      "monotonic"
    );

    expect(changed).toBe(true);
    const stored = store.getState().session_status?.ses_1 as SessionStatus & { attempt?: number; message?: string; next?: number };
    expect(stored.type).toBe("retry");
    expect(stored.attempt).toBe(2);
    expect(stored.message).toBe(
      "Cannot connect to API: Unable to connect. Is the computer able to access the url?"
    );
    expect(stored.next).toBe(30000);
  });

  test("retry status with connection error message is preserved during snapshot updates", () => {
    const store = createDirectoryStore({ session_status: {} });

    applySessionStatusSnapshot(
      store as unknown as StoreApi<DirectoryStore>,
      { ses_1: { type: "retry", attempt: 1, message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?", next: 10000 } },
      ["ses_1"],
      "monotonic"
    );

    // A subsequent update with increased attempt should preserve the message
    applySessionStatusSnapshot(
      store as unknown as StoreApi<DirectoryStore>,
      { ses_1: { type: "retry", attempt: 2, message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?", next: 30000 } },
      ["ses_1"],
      "monotonic"
    );

    const stored = store.getState().session_status?.ses_1 as SessionStatus & { attempt?: number; message?: string; next?: number };
    expect(stored.attempt).toBe(2);
    expect(stored.message).toBe(
      "Cannot connect to API: Unable to connect. Is the computer able to access the url?"
    );
    expect(stored.next).toBe(30000);
  });

  test("connection down retry updates properly in authoritative mode", () => {
    const store = createDirectoryStore({
      session_status: {
        ses_1: { type: "retry", attempt: 3, message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?", next: 60000 },
      },
    });

    // Authoritative mode with no retry status → should lower to idle
    const changed = applySessionStatusSnapshot(
      store as unknown as StoreApi<DirectoryStore>,
      {} as StatusSnapshot,
      ["ses_1"],
      "authoritative"
    );

    expect(changed).toBe(true);
    const stored = store.getState().session_status?.ses_1;
    expect(stored).toEqual({ type: "idle" });
  });

  test("session status type guard accepts retry with API connection error message", () => {
    // This mimics the check in ChatContainer: sessionStatusForCurrent.type === 'retry'
    const status: SessionStatus = {
      type: "retry",
      attempt: 1,
      message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      next: 30000,
    };

    expect(status.type).toBe("retry");
    expect(typeof status.attempt).toBe("number");
    expect(typeof status.message).toBe("string");
    expect(status.message?.length).toBeGreaterThan(0);
    expect((status as { next?: number }).next).toBe(30000);

    // The downstream consumer (ChatContainer) extracts the message:
    const rawMessage = typeof (status as { message?: string }).message === "string"
      ? ((status as { message?: string }).message ?? "").trim()
      : "";
    expect(rawMessage).toBe(
      "Cannot connect to API: Unable to connect. Is the computer able to access the url?"
    );

    // The fallback message (used when no message is provided):
    const DEFAULT_RETRY_MESSAGE = "Quota limit reached. Retrying automatically.";
    const finalMessage = rawMessage || DEFAULT_RETRY_MESSAGE;
    expect(finalMessage).toBe(rawMessage); // should use the actual message, not the fallback
    expect(finalMessage).not.toBe(DEFAULT_RETRY_MESSAGE);
  });
});
