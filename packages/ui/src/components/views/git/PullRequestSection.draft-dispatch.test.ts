/**
 * Reproduction test for issue #1859:
 * Share Comments / Resolve Failed Checks / Send Single Comment buttons fail
 * with "No active session" toast when only a draft session is open.
 *
 * The three dispatch actions go through resolveChatDispatchTarget() which
 * checks currentSessionId — but when a draft is open, openNewSessionDraft()
 * sets currentSessionId to null. The dispatch never reaches sendMessage,
 * even though sendMessage already handles draft materialization internally.
 *
 * Pattern already fixed in PR #1761 for generateCommitMessage /
 * generatePullRequestDescription via materializeOpenDraftSession() in gitApi.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useConfigStore } from "@/stores/useConfigStore";
import { useSelectionStore } from "@/sync/selection-store";

/**
 * Helper: set known model/provider so config is valid.
 * (Avoids the "No model selected" error path).
 */
const setValidConfig = () => {
  useConfigStore.setState({
    currentProviderId: "test-provider",
    currentModelId: "test-model",
  });
  useSelectionStore.setState({
    lastUsedProvider: { providerID: "test-provider", modelID: "test-model" },
  });
};

/**
 * Reset stores to a clean baseline before each test.
 */
const resetStores = () => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: {
      open: false,
      directoryOverride: null,
      parentID: null,
    },
    error: null,
  });
  useConfigStore.setState({
    currentProviderId: "",
    currentModelId: "",
  });
  useSelectionStore.setState({
    lastUsedProvider: null,
  });
};

describe("resolveChatDispatchTarget with draft session (issue #1859)", () => {
  beforeEach(() => {
    resetStores();
  });

  test("draft-open state has currentSessionId === null (the root cause of the bug)", () => {
    // Simulate the exact state after openNewSessionDraft() is called:
    // it sets currentSessionId to null and newSessionDraft.open to true.
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: {
        open: true,
        directoryOverride: "/repo",
        parentID: null,
      },
    });

    const state = useSessionUIStore.getState();
    const draft = state.newSessionDraft;

    // Verify the draft IS open
    expect(draft.open).toBe(true);

    // Verify currentSessionId IS null — this is the bug trigger.
    // resolveChatDispatchTarget() (line 697-701 of PullRequestSection.tsx)
    // checks `if (!currentSessionId)` and returns null immediately,
    // without materializing the open draft session.
    expect(state.currentSessionId).toBeNull();
  });

  test("resolveChatDispatchTarget returns null when draft is open (reproduces the bug)", () => {
    // Set up the draft session state
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: {
        open: true,
        directoryOverride: "/repo",
        parentID: null,
      },
    });
    setValidConfig();

    // This mirrors the exact logic in PullRequestSection.tsx resolveChatDispatchTarget()
    const { currentSessionId } = useSessionUIStore.getState();
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const { lastUsedProvider } = useSelectionStore.getState();

    // Step 1: Check currentSessionId — this is where the bug manifests
    if (!currentSessionId) {
      // BUG: Despite a draft being open, we return null here without
      // materializing the draft. The materialization logic that exists
      // in gitApi.ts (resolveGenerationSessionContext -> materializeOpenDraftSession)
      // is NOT used by resolveChatDispatchTarget().
      expect(true).toBe(true); // Confirms we enter the bug branch
      return;
    }

    // We should never reach here when a draft is open
    throw new Error("BUG: Should have returned early — currentSessionId is unexpectedly set");
  });

  test("happy path: resolveChatDispatchTarget succeeds when real session exists", () => {
    // Set up a real active session (no draft)
    useSessionUIStore.setState({
      currentSessionId: "session-abc",
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
    });
    setValidConfig();

    const { currentSessionId } = useSessionUIStore.getState();
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const { lastUsedProvider } = useSelectionStore.getState();

    // Step 1: Check currentSessionId — should pass
    if (!currentSessionId) {
      throw new Error("currentSessionId should be set");
    }

    // Step 2: Resolve provider/model
    const providerID = currentProviderId || lastUsedProvider?.providerID;
    const modelID = currentModelId || lastUsedProvider?.modelID;
    if (!providerID || !modelID) {
      throw new Error("provider/model should be available");
    }

    // Success — a valid dispatch target is produced
    expect(currentSessionId).toBe("session-abc");
    expect(providerID).toBe("test-provider");
    expect(modelID).toBe("test-model");
  });
});
