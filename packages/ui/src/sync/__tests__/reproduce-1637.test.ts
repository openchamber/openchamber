/**
 * Reproduction test for issue #1637
 *
 * Problem: When clicking the "+" button inside a project to start a new
 * conversation, the file directory shown in the file panel is not the directory
 * of that project. The session gets grouped under the wrong project.
 *
 * This test simulates the exact scenario described by the reporter:
 * 1. Multiple projects registered
 * 2. User has a current directory pointing to one project
 * 3. User clicks "+" on a DIFFERENT project
 * 4. Verify the draft's directoryOverride is correct
 * 5. Verify the session creation uses the correct directory
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

describe('Reproduce issue #1637 - wrong directory when clicking "+" on a project', () => {
  const PROJECT_A_PATH = '/home/user/project-a';
  const PROJECT_B_PATH = '/home/user/project-b';

  beforeEach(() => {
    // Reset session UI store
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: false,
        selectedProjectId: null,
        directoryOverride: null,
        pendingWorktreeRequestId: null,
        bootstrapPendingDirectory: null,
        preserveDirectoryOverride: false,
        parentID: null,
      },
      worktreeMetadata: new Map(),
      availableWorktrees: [],
      availableWorktreesByProject: new Map(),
      error: null,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      webUICreatedSessions: new Set(),
      sessionAbortFlags: new Map(),
      abortControllers: new Map(),
      isLoading: false,
      lastLoadedDirectory: null,
      sessionPlanAvailable: new Map(),
      pendingChangesBarDismissed: new Map(),
    });

    // Setup two projects, with Project B active
    useProjectsStore.setState({
      projects: [
        {
          id: 'project-a',
          path: PROJECT_A_PATH,
          label: 'Project A',
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
        },
        {
          id: 'project-b',
          path: PROJECT_B_PATH,
          label: 'Project B',
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
        },
      ],
      activeProjectId: 'project-b',
    });

    // Set current directory to Project B, which also updates opencodeClient
    useDirectoryStore.getState().setDirectory(PROJECT_B_PATH);
  });

  test('SCENARIO: Click "+" on Project A while browsing Project B', () => {
    // GIVEN: User is browsing Project B (currentDirectory = PROJECT_B_PATH)
    expect(useDirectoryStore.getState().currentDirectory).toBe(PROJECT_B_PATH);
    expect(opencodeClient.getDirectory()).toBe(PROJECT_B_PATH);

    // WHEN: User clicks "+" on Project A
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: PROJECT_A_PATH });

    // THEN: The draft opens with Project A's directory
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe(PROJECT_A_PATH);

    // AND: opencodeClient.getDirectory() is STILL Project B
    // (openNewSessionDraft does NOT update opencodeClient's directory!)
    expect(opencodeClient.getDirectory()).toBe(PROJECT_B_PATH);
  });

  test('SCENARIO: Session creation uses draft directoryOverride even if server returns no directory', () => {
    // GIVEN: Draft open with Project A's directory
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: PROJECT_A_PATH });
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.directoryOverride).toBe(PROJECT_A_PATH);

    // Simulate sendMessage flow (session-ui-store.ts):
    const draftDirectoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null;
    expect(draftDirectoryOverride).toBe(PROJECT_A_PATH);

    // Simulate createSession (session-ui-store.ts line 1018):
    // const dir = directoryOverride ?? opencodeClient.getDirectory()
    const dir = draftDirectoryOverride ?? opencodeClient.getDirectory();
    expect(dir).toBe(PROJECT_A_PATH);
  });

  test('SCENARIO: Session resolved directory is correct for project grouping', () => {
    const session = {
      id: 'session-1',
      directory: PROJECT_A_PATH,
      slug: 'session-1',
      projectID: null,
      title: 'Test Session',
      version: 1,
      time: { created: Date.now() },
    } as const;

    const resolvedDir = resolveGlobalSessionDirectory(session as any);
    expect(resolvedDir).toBe(PROJECT_A_PATH);
  });

  test('SCENARIO: Server returns session without directory - fallback risk', () => {
    // This test demonstrates the POTENTIAL BUG:
    // If the server does not return the directory field in the session.create
    // response, createSessionAction calls setCurrentSession(session.id, null)
    // which falls back to opencodeClient.getDirectory().
    // 
    // At this point, opencodeClient.getDirectory() still returns PROJECT_B_PATH
    // because openNewSessionDraft doesn't update it.
    //
    // Though sendMessage corrects this with a second setCurrentSession call,
    // any code path that reads the directory between the two calls would
    // see the WRONG directory.

    // Step 1: open draft for Project A
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: PROJECT_A_PATH });

    // Step 2: opencodeClient.getDirectory() still returns Project B
    expect(opencodeClient.getDirectory()).toBe(PROJECT_B_PATH);

    // Step 3: Simulate what createSessionAction does when server returns no directory
    // It calls: useSessionUIStore.getState().setCurrentSession(session.id, null)
    // The sessionDir would be null, so setCurrentSession resolves:
    //   resolvedDir = null ?? null ?? opencodeClient.getDirectory() = PROJECT_B_PATH
    // This would temporarily set the wrong directory!

    // The sendMessage then corrects it with:
    // get().setCurrentSession(created.id, createdDirectory) where createdDirectory = PROJECT_A_PATH
    // But if any component reads the session's directory between these two calls,
    // it would get PROJECT_B_PATH.
    
    // This is the ROOT CAUSE: openNewSessionDraft doesn't update the 
    // opencodeClient's directory or DirectoryStore.currentDirectory,
    // so any fallback that reads these will get the stale value.
    expect(opencodeClient.getDirectory()).toBe(PROJECT_B_PATH);
    expect(useDirectoryStore.getState().currentDirectory).toBe(PROJECT_B_PATH);
  });
});
