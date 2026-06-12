/**
 * Reproduction test for Issue #1630
 *
 * Bug: Session bar disables prematurely — model still processing but UI
 * shows session ended.
 *
 * Root cause: useSessionActivity() at line 54 returns IDLE_RESULT
 * immediately when session.status says "idle", even when there is a
 * pending (incomplete) assistant message that indicates the session is
 * still working between internal turns (reasoning→content, parent→subagent).
 *
 * The SDK legitimately emits "idle" between internal turns of a single
 * user request. The chamber UI should not treat these as "session ended".
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Pure logic extracted from useSessionActivity() — lines 33–64 of the hook
// ---------------------------------------------------------------------------

type SessionStatus =
  | { type: "busy" }
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number };

type Message = {
  id: string;
  role: "user" | "assistant";
  time?: { created: number; completed?: number };
};

type SessionActivityPhase = "idle" | "busy" | "retry";

interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: "idle",
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

function computeSessionActivity(
  sessionId: string | null | undefined,
  status: SessionStatus | undefined,
  messages: Message[],
  permissions: unknown[],
): SessionActivityResult {
  // This is an exact copy of the useMemo body from useSessionActivity.ts lines 33–64.
  // The bug is on line 54 (marked below).
  if (!sessionId) return IDLE_RESULT;

  // Permissions pending → idle (permission indicator takes priority)
  if (permissions.length > 0) return IDLE_RESULT;

  const phase: SessionActivityPhase = (status?.type ?? "idle") as SessionActivityPhase;

  // Only trust the trailing assistant message as a transient fallback while
  // waiting for session.status/message.updated to settle.
  const lastMessage = messages[messages.length - 1];
  const hasPendingAssistant = Boolean(
    lastMessage &&
      lastMessage.role === "assistant" &&
      typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number",
  );

  const hasAuthoritativeStatus = status !== undefined;
  const statusWorking = hasAuthoritativeStatus && phase !== "idle";
  const isWorking = statusWorking || hasPendingAssistant;

  // *** LINE 54 — THE BUG ***
  // When session.status says "idle", this returns IDLE_RESULT immediately,
  // even if the last assistant message is still incomplete (hasPendingAssistant).
  // The hasPendingAssistant fallback was designed for exactly this scenario
  // (no status yet, but messages say work is happening), but line 54 overrides
  // it when the status IS present.
  if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;

  if (!isWorking) return IDLE_RESULT;

  return {
    phase: statusWorking ? phase : "busy",
    isWorking: true,
    isBusy: phase === "busy" || (!statusWorking && hasPendingAssistant),
    isCooldown: false,
  };
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const NO_PERMISSIONS: unknown[] = [];
const EMPTY_MESSAGES: Message[] = [];

function makeAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    role: "assistant",
    time: { created: 1000, completed: undefined },
    ...overrides,
  };
}

function makeCompleteAssistantMessage(): Message {
  return makeAssistantMessage({ time: { created: 1000, completed: 2000 } });
}

// ---------------------------------------------------------------------------
// Test: idle status during active assistant message should NOT return idle
// ---------------------------------------------------------------------------

describe("Issue #1630 — session.status=idle during active streaming", () => {
  test("busy status → returns working (correct, baseline check)", () => {
    const result = computeSessionActivity(
      "ses_1",
      { type: "busy" },
      [makeAssistantMessage()],
      NO_PERMISSIONS,
    );

    expect(result.isWorking).toBe(true);
    expect(result.phase).toBe("busy");
  });

  test("no status + pending assistant → returns working (fallback works)", () => {
    const result = computeSessionActivity(
      "ses_1",
      undefined, // no authoritative status yet
      [makeAssistantMessage()],
      NO_PERMISSIONS,
    );

    expect(result.isWorking).toBe(true);
    expect(result.phase).toBe("busy");
  });

  test("idle status + no pending assistant → returns idle (correct)", () => {
    const result = computeSessionActivity(
      "ses_1",
      { type: "idle" },
      [makeCompleteAssistantMessage()],
      NO_PERMISSIONS,
    );

    expect(result.isWorking).toBe(false);
    expect(result.phase).toBe("idle");
  });

  // ==========================================================================
  // THE BUG — Issue #1630
  //
  // Scenario: Model pauses between internal turns (e.g., reasoning → content,
  // parent session → subagent delegation). The SDK emits session.status=idle.
  // The last assistant message has no time.completed (still in progress).
  //
  // EXPECTED: isWorking = true  (session is still active)
  // ACTUAL:   isWorking = false (prematurely shows session ended)
  //
  // Root cause: useSessionActivity() line 54:
  //   if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;
  // This short-circuits before hasPendingAssistant can compensate.
  // ==========================================================================
  test("idle status + PENDING assistant → returns idle (BUG confimred)", () => {
    const result = computeSessionActivity(
      "ses_1",
      { type: "idle" },
      [makeAssistantMessage()], // <-- no time.completed = still in progress
      NO_PERMISSIONS,
    );

    // These assertions PASS with current code, confirming the bug:
    // the UI shows "session ended" even though the model is still
    // processing (pending assistant message with no completion time).
    expect(result.isWorking).toBe(false); // BUG: should be true
    expect(result.phase).toBe("idle"); // BUG: should be "busy"
  });

  // Multiple assistant messages — the last one is still pending
  test("idle status + multiple messages + last one pending → idle (BUG confirmed)", () => {
    const result = computeSessionActivity(
      "ses_1",
      { type: "idle" },
      [
        { id: "msg_1", role: "user", time: { created: 500 } },
        { id: "msg_2", role: "assistant", time: { created: 1000, completed: 1500 } },
        { id: "msg_3", role: "user", time: { created: 2000 } },
        { id: "msg_4", role: "assistant", time: { created: 2500 } }, // pending, no completed
      ],
      NO_PERMISSIONS,
    );

    expect(result.isWorking).toBe(false); // BUG: should be true
  });

  // ==========================================================================
  // The fix: change line 54 from:
  //   if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;
  // to:
  //   if (hasAuthoritativeStatus && !statusWorking && !hasPendingAssistant) return IDLE_RESULT;
  //
  // This lets hasPendingAssistant override the idle status when there's an
  // incomplete assistant message.
  // ==========================================================================
});
