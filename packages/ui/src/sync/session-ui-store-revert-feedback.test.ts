import { beforeEach, describe, expect, mock, test } from "bun:test"

const toastErrors: string[] = []
let refetchFailure: Error | null = null
let revertFailure: Error | null = null

mock.module("sonner", () => ({
  toast: {
    error: (message: string) => toastErrors.push(message),
    success: () => undefined,
  },
}))

mock.module("./session-actions", () => ({
  setActionRefs: () => undefined,
  setOptimisticRefs: () => undefined,
  createSession: mock(async () => undefined),
  deleteSession: mock(async () => true),
  deleteSessions: mock(async () => ({ deletedIds: [], failedIds: [] })),
  archiveSession: mock(async () => true),
  archiveSessions: mock(async () => ({ archivedIds: [], failedIds: [] })),
  unarchiveSession: mock(async () => true),
  unarchiveSessions: mock(async () => ({ restoredIds: [], failedIds: [] })),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async () => undefined),
  refetchSessionMessages: mock(async () => {
    if (refetchFailure) throw refetchFailure
  }),
  revertToMessage: mock(async () => {
    if (revertFailure) throw revertFailure
  }),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  patchSessionMetadata: mock(async () => undefined),
  abortCurrentOperation: mock(async () => undefined),
  waitForConnectionOrThrow: mock(async () => undefined),
  getSessionLiveActivity: () => "idle",
  isSessionBusyNow: () => false,
  isQuestionRequestNotFoundError: () => false,
  moveSessionToDirectory: mock(async () => undefined),
  setLinkedIssue: mock(async () => undefined),
  setContextObligatoryMessage: mock(async () => undefined),
  deleteSessionInDirectory: mock(async () => true),
  respondToPermission: mock(async () => undefined),
  dismissPermission: mock(async () => undefined),
  dismissOpenPermissionsForSession: mock(async () => true),
  respondToQuestion: mock(async () => undefined),
  rejectQuestion: mock(async () => undefined),
  dismissOpenQuestionsForSession: mock(async () => true),
}))

const { useSessionUIStore } = await import("./session-ui-store")

async function expectRevertFailure(failure: Error) {
  const rejection = await useSessionUIStore.getState()
    .revertToMessage("session-a", "message-a")
    .catch((error: Error) => error)

  expect(rejection).toBe(failure)
  expect(toastErrors).toEqual(["Failed to revert message"])
}

describe("revert failure feedback", () => {
  beforeEach(() => {
    toastErrors.length = 0
    refetchFailure = null
    revertFailure = null
  })

  test("reports a message refetch failure once and preserves the rejection", async () => {
    refetchFailure = new Error("refetch rejected")
    await expectRevertFailure(refetchFailure)
  })

  test("reports a revert failure once and preserves the rejection", async () => {
    revertFailure = new Error("revert rejected")
    await expectRevertFailure(revertFailure)
  })
})
