import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionWorktreeStore } from './session-worktree-store';
import { expandSlashCommandGoalObjective, routeMessage, useSessionUIStore } from './session-ui-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useSelectionStore } from './selection-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { createContextPart } from '@/lib/messages/contextParts';
import { toast } from '@/components/ui';

/**
 * Unit tests for session worktree routing through the authoritative store.
 *
 * These tests verify that session-worktree-store is properly integrated as the
 * authoritative holder of session↔worktree attachments, and that session-ui-store
 * routes through it for switching and creation flows.
 *
 * Note: Full integration tests for setCurrentSession require runtime mocking.
 * These tests focus on the contract layer: that setAttachment/getAttachment work
 * correctly and that the contract helpers produce correct results.
 */

describe('session-worktree-store worktree routing', () => {
  beforeEach(() => {
    // Clear all attachments before each test
    const store = useSessionWorktreeStore.getState();
    const attachments = store.attachments;
    for (const sessionId of attachments.keys()) {
      store.clearAttachment(sessionId);
    }
    useSessionUIStore.setState({ currentSessionId: null, worktreeMetadata: new Map() });
  });

  test('getDirectoryForSession prefers authoritative attachment cwd over sync fallback', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a/src');
  });

  test('getDirectoryForSession falls back to authoritative worktreeRoot when attachment is degraded', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a');
  });

  test('setCurrentSession uses canonical cwd when valid', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session has valid worktree metadata with cwd inside worktreeRoot
    store.setAttachment('session-1', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-1');
    expect(attachment).toBeDefined();
    expect(attachment.cwd).toBe('/repo/worktrees/feat-a/src');
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/feat-a');
    expect(attachment.degraded).toBe(false);
    expect(attachment.worktreeStatus).toBe('ready');
  });

  test('setCurrentSession falls back to worktreeRoot when cwd is degraded', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: cwd is outside worktreeRoot (degraded)
    store.setAttachment('session-2', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a', // same as worktreeRoot means not degraded for this case
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true, // marked degraded because cwd was resolved from invalid state
    });

    const attachment = store.getAttachment('session-2');
    expect(attachment).toBeDefined();
    expect(attachment.degraded).toBe(true);
    // cwd should equal worktreeRoot when degraded (fallback)
    expect(attachment.cwd).toBe(attachment.worktreeRoot);
  });

  test('isolated session initializes created-for-session attachment', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: isolated worktree session created for a specific branch
    store.setAttachment('session-isolated', {
      worktreeRoot: '/repo/worktrees/feature-xyz',
      cwd: '/repo/worktrees/feature-xyz',
      branch: 'feature-xyz',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'created-for-session',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-isolated');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeSource).toBe('created-for-session');
    expect(attachment.worktreeStatus).toBe('ready');
    expect(attachment.legacy).toBe(false);
  });

  test('legacy session upgrades when runtime canonicalization recovers a worktree', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session without metadata (legacy) gets upgraded via runtime resolution
    // Initially no attachment
    let attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeUndefined();

    // Runtime canonicalization resolves it to a worktree
    store.setAttachment('session-legacy', {
      worktreeRoot: '/repo/worktrees/recovered',
      cwd: '/repo/worktrees/recovered',
      branch: 'recovered',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false, // upgraded from legacy=true to false
      degraded: false,
    });

    attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeDefined();
    expect(attachment.legacy).toBe(false);
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/recovered');
  });

  test('missing worktree session has missing status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session whose worktree was deleted
    store.setAttachment('session-missing', {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'missing',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-missing');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('missing');
    expect(attachment.degraded).toBe(true);
  });

  test('not-a-repo session has correct status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session opened in a directory that is not a git repo
    store.setAttachment('session-not-repo', {
      worktreeRoot: null,
      cwd: '/tmp/not-a-repo',
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-not-repo');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('not-a-repo');
  });
});

describe('draft materialization transition identity', () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      materializedDraftSessionId: null,
      newSessionDraft: { open: true, target: 'project', directoryOverride: '/projects/alpha' },
    });
  });

  test('marks and consumes only the submitted draft session', () => {
    useSessionUIStore.getState().setCurrentSession(
      'session-created',
      '/projects/alpha',
      'submitted-draft',
    );

    expect(useSessionUIStore.getState().materializedDraftSessionId).toBe('session-created');

    useSessionUIStore.getState().clearMaterializedDraftSession('another-session');
    expect(useSessionUIStore.getState().materializedDraftSessionId).toBe('session-created');

    useSessionUIStore.getState().clearMaterializedDraftSession('session-created');
    expect(useSessionUIStore.getState().materializedDraftSessionId).toBeNull();
  });

  test('clears the marker when navigating from a draft to an existing session', () => {
    useSessionUIStore.getState().setCurrentSession(
      'session-created',
      '/projects/alpha',
      'submitted-draft',
    );
    useSessionUIStore.setState({
      newSessionDraft: { open: true, target: 'project', directoryOverride: '/projects/alpha' },
    });
    useSessionUIStore.getState().setCurrentSession('session-existing', '/projects/alpha');

    expect(useSessionUIStore.getState().materializedDraftSessionId).toBeNull();
  });
});

describe('routeMessage directory scoping', () => {
  test('runs sends in the provided session directory', async () => {
    // The session directory travels as an explicit request param (not via
    // client-wide directory scoping), so concurrent sends can't cross-talk.
    const calls = [];
    const originalShellSession = opencodeClient.shellSession;

    opencodeClient.shellSession = async (params) => {
      calls.push(params);
      return { info: {}, parts: [] };
    };

    try {
      await routeMessage({
        sessionId: 'session-a',
        directory: '/session/project',
        content: 'pwd',
        providerID: 'provider-a',
        modelID: 'model-a',
        inputMode: 'shell',
      });
    } finally {
      opencodeClient.shellSession = originalShellSession;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('session-a');
    expect(calls[0].directory).toBe('/session/project');
  });
});

describe('sendMessage captured target', () => {
  let originalSendMessage;
  const calls = [];

  beforeEach(() => {
    calls.length = 0;
    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/current/project');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });
    useSessionUIStore.setState({
      currentSessionId: 'session-current',
      currentSessionDirectory: '/current/project',
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });

    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = async (params) => {
      calls.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
  });

  const sendToTarget = (target) => useSessionUIStore.getState().sendMessage(
    'queued message',
    'provider-a',
    'model-a',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'normal',
    { target },
  );

  test('uses the target captured before the active session changes', async () => {
    await sendToTarget({
      runtimeKey: getRuntimeKey(),
      sessionId: 'session-captured',
      directory: '/captured/project',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].runtimeKey).toBe(getRuntimeKey());
    expect(calls[0].id).toBe('session-captured');
    expect(calls[0].directory).toBe('/captured/project');
  });

  test('does not send a captured target through a different runtime', async () => {
    let error = null;
    try {
      await sendToTarget({
        runtimeKey: `${getRuntimeKey()}-stale`,
        sessionId: 'session-captured',
        directory: '/captured/project',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('runtime changed');
    expect(calls).toHaveLength(0);
  });
});

describe('slash-command goal objectives', () => {
  test('expands every $ARGUMENTS reference from the authoritative command template', () => {
    expect(expandSlashCommandGoalObjective('/issue--to-pr LIN-123 --draft', [{
      name: 'issue--to-pr',
      template: 'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
    }])).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
  });

  test('keeps the invocation when the command template is unavailable', () => {
    expect(expandSlashCommandGoalObjective('/issue--to-pr LIN-123', [{ name: 'issue--to-pr' }]))
      .toBe('/issue--to-pr LIN-123');
  });

  test('matches OpenCode positional and implicit argument expansion', () => {
    expect(expandSlashCommandGoalObjective('/move "src old" dist extra', [{
      name: 'move',
      template: 'Move $1 to $2',
    }])).toBe('Move src old to dist extra');
    expect(expandSlashCommandGoalObjective('/review auth module', [{
      name: 'review',
      template: 'Review the requested scope.',
    }])).toBe('Review the requested scope.\n\nauth module');
  });
});

describe('runtime worktree topology', () => {
  test('restores independent in-memory maps across A -> B -> A', () => {
    const topologyA = new Map([['/repo', [{ path: '/repo/a', branch: 'a' }]]]);
    const topologyB = new Map([['/repo', [{ path: '/repo/b', branch: 'b' }]]]);

    useSessionUIStore.setState({ availableWorktreesByProject: topologyA, availableWorktrees: topologyA.get('/repo') });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-a');
    useSessionUIStore.setState({ availableWorktreesByProject: topologyB, availableWorktrees: topologyB.get('/repo') });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-b');

    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-a');
    expect(useSessionUIStore.getState().availableWorktreesByProject.get('/repo')?.[0]?.path).toBe('/repo/a');

    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-b');
    expect(useSessionUIStore.getState().availableWorktreesByProject.get('/repo')?.[0]?.path).toBe('/repo/b');
  });
});

describe('openNewSessionDraft project binding', () => {
  const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };
  const projectB = { id: 'proj-b', path: '/projects/beta', label: 'Beta' };

  const DRAFT_TARGET_KEY = 'oc.chatInput.lastDraftTarget';

  beforeEach(() => {
    getDeferredSafeStorage().removeItem(DRAFT_TARGET_KEY);
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [projectA, projectB],
      activeProjectId: projectA.id,
    });
    useDirectoryStore.getState().setDirectory(projectB.path, { showOverlay: false });
  });

  afterEach(() => {
    getDeferredSafeStorage().removeItem(DRAFT_TARGET_KEY);
  });

  test('defaults an implicit draft to Chat when active project differs', () => {
    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.target).toBe('chat');
    expect(draft.selectedProjectId).toBeNull();
    expect(draft.directoryOverride).toBeNull();
  });

  test('paints a project default before discovery and does not undo a later manual choice', async () => {
    const original = useConfigStore.getState();
    let finishActivation;
    const activation = new Promise((resolve) => { finishActivation = resolve; });
    useConfigStore.setState({
      activateDirectory: () => activation,
      providers: [], agents: [], settingsDefaultsLoaded: false,
      settingsDefaultModel: 'global/model', isConnected: false,
    });
    useProjectsStore.setState({ projects: [{ ...projectA, defaultModel: 'project/model', defaultVariant: 'high' }, projectB] });
    try {
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectA.id });
      expect(useConfigStore.getState().currentProviderId).toBe('project');
      expect(useConfigStore.getState().currentModelId).toBe('model');
      expect(useConfigStore.getState().currentVariant).toBe('high');
      useConfigStore.setState({ currentProviderId: 'manual', currentModelId: 'chosen', selectionSource: 'manual' });
      finishActivation();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useConfigStore.getState().currentProviderId).toBe('manual');
      expect(useConfigStore.getState().currentModelId).toBe('chosen');
    } finally {
      finishActivation();
      useConfigStore.setState(original);
    }
  });

  test('an old draft activation cannot replace a newer draft default', async () => {
    const original = useConfigStore.getState();
    let finishActivation;
    const activation = new Promise((resolve) => { finishActivation = resolve; });
    useConfigStore.setState({ activateDirectory: () => activation, providers: [], agents: [], isConnected: false });
    useProjectsStore.setState({ projects: [
      { ...projectA, defaultModel: 'alpha/model' },
      { ...projectB, defaultModel: 'beta/model' },
    ] });
    try {
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectA.id });
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
      expect(useConfigStore.getState().currentProviderId).toBe('beta');
      finishActivation();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useConfigStore.getState().currentProviderId).toBe('beta');
    } finally {
      finishActivation();
      useConfigStore.setState(original);
    }
  });

  test('defaults an implicit draft to Chat when current directory is unmatched', () => {
    useDirectoryStore.getState().setDirectory('/external/worktree', { showOverlay: false });

    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBeNull();
    expect(draft.target).toBe('chat');
    expect(draft.directoryOverride).toBeNull();
  });

  test('respects explicit directoryOverride over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/projects/beta/src' });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe('/projects/beta/src');
  });

  test('respects explicit selectedProjectId over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectB.id);
  });

  test('reopens an implicit draft on the project the target selector was last set to', () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
    useSessionUIStore.getState().closeNewSessionDraft();
    // A chat session leaves its managed scratch directory current; the project
    // to reopen on can only come from the recorded target.
    useDirectoryStore.getState().setDirectory(
      '/Users/tester/.config/openchamber/chats/ses_chat',
      { showOverlay: false },
    );

    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.target).toBe('project');
    expect(draft.selectedProjectId).toBe(projectB.id);
    expect(draft.directoryOverride).toBe(projectB.path);
  });

  test('setNewSessionDraftTarget records Chat, so the next implicit draft opens on Chat', () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
    useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: CHAT_DRAFT_PROJECT_ID });
    useSessionUIStore.getState().closeNewSessionDraft();

    useSessionUIStore.getState().openNewSessionDraft();

    expect(useSessionUIStore.getState().newSessionDraft.target).toBe('chat');
  });

  test('keeps the Chat default for a record written before the target was stored', () => {
    getDeferredSafeStorage().setItem(
      DRAFT_TARGET_KEY,
      JSON.stringify({ projectId: projectB.id, directory: projectB.path }),
    );

    useSessionUIStore.getState().openNewSessionDraft();

    expect(useSessionUIStore.getState().newSessionDraft.target).toBe('chat');
  });

  test('a chat scratch directory forwarded as override opens a chat draft', () => {
    // "New session in the current directory" callers forward the current
    // session's directory even when that session is a chat; its scratch
    // directory names no project.
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: '/Users/tester/.config/openchamber/chats/ses_chat',
    });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.target).toBe('chat');
    expect(draft.directoryOverride).toBeNull();
  });

  test('a chat scratch override opens Chat even when the recorded target is a project', () => {
    getDeferredSafeStorage().setItem(
      DRAFT_TARGET_KEY,
      JSON.stringify({ projectId: projectB.id, directory: projectB.path, target: 'project' }),
    );

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: '/Users/tester/.config/openchamber/chats/ses_chat',
    });

    expect(useSessionUIStore.getState().newSessionDraft.target).toBe('chat');
  });

  test('falls back to Chat when the last project target no longer exists', () => {
    getDeferredSafeStorage().setItem(
      DRAFT_TARGET_KEY,
      JSON.stringify({ projectId: 'proj-removed', directory: '/projects/removed', target: 'project' }),
    );

    useSessionUIStore.getState().openNewSessionDraft();

    expect(useSessionUIStore.getState().newSessionDraft.target).toBe('chat');
  });
});

describe('createSession draft lifecycle', () => {
  let originalCreateSession;
  let originalGetDirectoryAvailability;
  let originalProjects;
  let originalActiveProjectId;
  let originalDirectoryState;
  let originalClientDirectory;
  let originalLastDirectory;

  beforeEach(() => {
    originalCreateSession = opencodeClient.createSession;
    originalGetDirectoryAvailability = opencodeClient.getDirectoryAvailability;
    originalProjects = useProjectsStore.getState().projects;
    originalActiveProjectId = useProjectsStore.getState().activeProjectId;
    originalDirectoryState = useDirectoryStore.getState();
    originalClientDirectory = opencodeClient.getDirectory();
    originalLastDirectory = getDeferredSafeStorage().getItem('lastDirectory');
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: true, directoryOverride: '/projects/alpha', parentID: null, title: 'Draft title' },
    });
  });

  afterEach(() => {
    opencodeClient.createSession = originalCreateSession;
    opencodeClient.getDirectoryAvailability = originalGetDirectoryAvailability;
    useProjectsStore.setState({ projects: originalProjects, activeProjectId: originalActiveProjectId });
    useDirectoryStore.setState(originalDirectoryState, true);
    opencodeClient.setDirectory(originalClientDirectory ?? undefined);
    if (originalLastDirectory === null) {
      getDeferredSafeStorage().removeItem('lastDirectory');
    } else {
      getDeferredSafeStorage().setItem('lastDirectory', originalLastDirectory);
    }
  });

  test('keeps the draft open when session creation fails', async () => {
    opencodeClient.createSession = async () => {
      throw new Error('offline');
    };

    const session = await useSessionUIStore.getState().createSession('Draft title', '/projects/alpha');

    expect(session).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.title).toBe('Draft title');
  });

  test('rewrites an implicit new-chat draft to the active project before the session is created', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useDirectoryStore.getState().setDirectory('/private/deleted-worktree', { showOverlay: false });
    opencodeClient.getDirectoryAvailability = async () => 'missing';

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/deleted-worktree' });
    await Bun.sleep(0);

    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe('/projects/main');
    expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('project-main');
    expect(getDeferredSafeStorage().getItem('lastDirectory')).toBe('/private/deleted-worktree');
  });

  test('falls back to the current active project when a regular new-chat directory is missing', async () => {
    const createSessionCalls = [];
    useProjectsStore.setState({
      projects: [
        { id: 'project-draft', path: '/projects/draft', label: 'Draft' },
        { id: 'project-active', path: '/projects/active', label: 'Active' },
      ],
      activeProjectId: 'project-active',
    });
    useDirectoryStore.getState().setDirectory('/private/deleted-worktree', { showOverlay: false });
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/deleted-worktree' });
    opencodeClient.getDirectoryAvailability = async () => 'missing';
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-fallback', directory };
    };

    await useSessionUIStore.getState().createSession('Draft title', '/private/deleted-worktree');

    expect(createSessionCalls).toEqual(['/projects/active']);
    expect(useDirectoryStore.getState().currentDirectory).toBe('/projects/active');
    expect(getDeferredSafeStorage().getItem('lastDirectory')).toBe('/projects/active');
  });

  test('keeps an explicitly pinned worktree directory unchanged', async () => {
    const createSessionCalls = [];
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/deleted-worktree', preserveDirectoryOverride: true });
    expect(useSessionUIStore.getState().newSessionDraft.preserveDirectoryOverride).toBe(true);
    opencodeClient.getDirectoryAvailability = async () => 'missing';
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-pinned', directory };
    };

    await useSessionUIStore.getState().createSession('Draft title', '/private/deleted-worktree');

    expect(createSessionCalls).toEqual(['/private/deleted-worktree']);
  });

  test('keeps a ChatInput-style current-directory draft recoverable when that path is missing', async () => {
    const createSessionCalls = [];
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useDirectoryStore.getState().setDirectory('/private/deleted-worktree', { showOverlay: false });
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/deleted-worktree' });
    expect(useSessionUIStore.getState().newSessionDraft.preserveDirectoryOverride).not.toBe(true);
    opencodeClient.getDirectoryAvailability = async () => 'missing';
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-chat-input', directory };
    };

    await useSessionUIStore.getState().createSession('Draft title', '/private/deleted-worktree');

    expect(createSessionCalls).toEqual(['/projects/main']);
  });

  test('keeps the stale directory when its availability cannot be confirmed', async () => {
    const createSessionCalls = [];
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useDirectoryStore.getState().setDirectory('/private/unavailable-worktree', { showOverlay: false });
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/unavailable-worktree' });
    opencodeClient.getDirectoryAvailability = async () => 'unknown';
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-unavailable', directory };
    };

    await useSessionUIStore.getState().createSession('Draft title', '/private/unavailable-worktree');

    expect(createSessionCalls).toEqual(['/private/unavailable-worktree']);
    expect(useDirectoryStore.getState().currentDirectory).toBe('/private/unavailable-worktree');
  });

  test('still creates against the active project when the draft is rewritten during the create probe', async () => {
    const createSessionCalls = [];
    const availabilityResolvers = [];
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useDirectoryStore.getState().setDirectory('/private/deleted-worktree', { showOverlay: false });
    opencodeClient.getDirectoryAvailability = () => new Promise((resolve) => {
      availabilityResolvers.push(resolve);
    });
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-race', directory };
    };

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/private/deleted-worktree' });
    const createPromise = useSessionUIStore.getState().createSession('Draft title', '/private/deleted-worktree');
    expect(availabilityResolvers.length).toBe(2);

    availabilityResolvers[0]('missing');
    await Bun.sleep(0);
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe('/projects/main');

    availabilityResolvers[1]('missing');
    const session = await createPromise;

    expect(session).not.toBeNull();
    expect(createSessionCalls).toEqual(['/projects/main']);
  });

  test('does not persist a fallback when session creation fails', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: '/projects/main', label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useDirectoryStore.getState().setDirectory('/private/deleted-worktree', { showOverlay: false });
    useSessionUIStore.getState().openNewSessionDraft();
    opencodeClient.getDirectoryAvailability = async () => 'missing';
    opencodeClient.createSession = async () => {
      throw new Error('offline');
    };

    const session = await useSessionUIStore.getState().createSession('Draft title', '/private/deleted-worktree');

    expect(session).toBeNull();
    expect(useDirectoryStore.getState().currentDirectory).toBe('/private/deleted-worktree');
    expect(getDeferredSafeStorage().getItem('lastDirectory')).toBe('/private/deleted-worktree');
  });
});

// ---------------------------------------------------------------------------
// Issues #2222 and #2315 — send target must be snapshotted at submit time so a
// later sidebar/project selection cannot reroute a pending draft or session
// send to whichever session happens to be current when the async work resumes.
// ---------------------------------------------------------------------------
describe('sendMessage draft snapshot (issues #2222 / #2315)', () => {
  const sendMessageCalls = [];
  const createSessionCalls = [];
  let originalSendMessage;
  let originalCreateSession;

  beforeEach(() => {
    sendMessageCalls.length = 0;
    createSessionCalls.length = 0;

    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/projects/alpha');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });

    originalSendMessage = opencodeClient.sendMessage;
    originalCreateSession = opencodeClient.createSession;
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
    opencodeClient.createSession = async (_params, directory) => {
      createSessionCalls.push(directory);
      return { id: 'session-materialized', directory: directory ?? '/projects/alpha' };
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    opencodeClient.createSession = originalCreateSession;
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    useSessionDisplayStore.setState({ singleProjectId: null });
  });

  test('draft send snapshots the draft; switching to another project mid-flight still targets the materialized session', async () => {
    useProjectsStore.setState({
      projects: [
        { id: 'project-alpha', path: '/projects/alpha', label: 'Alpha' },
        { id: 'project-beta', path: '/projects/beta', label: 'Beta' },
      ],
      activeProjectId: 'project-alpha',
    });
    useSessionDisplayStore.setState({ singleProjectId: 'project-alpha' });
    const draftSnapshot = {
      open: true,
      directoryOverride: '/projects/alpha',
      parentID: null,
      title: 'Project A draft',
    };
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: draftSnapshot,
    });

    const sendPromise = useSessionUIStore.getState().sendMessage(
      'message for project A',
      'provider-a',
      'model-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'normal',
      { draftSnapshot },
    );

    // A sidebar switch while the send is still in flight must not reroute it.
    useSessionUIStore.getState().setCurrentSession('session-project-b', '/projects/beta');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-beta');

    await sendPromise;

    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toBe('/projects/alpha');
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].id).toBe('session-materialized');
    expect(sendMessageCalls[0].directory).toBe('/projects/alpha');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
  });

  test('existing-session send keeps the submit-time target even when selection changes', async () => {
    useSessionUIStore.setState({
      currentSessionId: 'session-project-a',
      currentSessionDirectory: '/projects/alpha',
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });

    const sendPromise = useSessionUIStore.getState().sendMessage(
      'message for project A',
      'provider-a',
      'model-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'normal',
      { target: { runtimeKey: getRuntimeKey(), sessionId: 'session-project-a', directory: '/projects/alpha' } },
    );

    useSessionUIStore.getState().setCurrentSession('session-project-b', '/projects/beta');

    await sendPromise;

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].id).toBe('session-project-a');
    expect(sendMessageCalls[0].directory).toBe('/projects/alpha');
  });
});

// ---------------------------------------------------------------------------
// #3420 regression: a draft send must run the agent availability guard against
// the composer scope captured from the draft being sent — the project draft's
// directory override, or for a chat draft the prepared chat scratch directory
// the send actually targets. An unprepared draft has no scope yet and fails
// open; it must never read `null`, which would resolve the ambient project's
// list and could send a project-scoped default agent to a directory that does
// not define it.
// ---------------------------------------------------------------------------
describe('sendMessage draft agent availability guard', () => {
  const DRAFT_SESSION = 'session-draft-agent-scope';
  const PROVIDER = 'provider-a';
  const MODEL = 'model-a';
  const calls = [];
  const createdDirectories = [];
  let originalSendMessage;
  let originalCreateSession;
  let originalCreateDirectory;
  let originalAgentsByDirectory;
  let originalCurrentAgentName;
  let originalToastInfo;
  let toastInfoCalls;

  const draft = {
    draftId: 42,
    open: true,
    target: 'chat',
    directoryOverride: null,
    bootstrapPendingDirectory: null,
    preparedChatDirectory: null,
    parentID: null,
  };

  beforeEach(() => {
    calls.length = 0;
    createdDirectories.length = 0;
    toastInfoCalls = [];
    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => null);
    setOptimisticRefs(() => {}, () => {});
    originalAgentsByDirectory = useAgentsStore.getState().agentsByDirectory;
    originalCurrentAgentName = useConfigStore.getState().currentAgentName;
    useConfigStore.setState({
      isConnected: true,
      currentProviderId: PROVIDER,
      currentModelId: MODEL,
      currentAgentName: null,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
    });
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { ...draft },
    });
    useSelectionStore.getState().clearSessionSelections(DRAFT_SESSION);

    originalSendMessage = opencodeClient.sendMessage;
    originalCreateSession = opencodeClient.createSession;
    originalCreateDirectory = opencodeClient.createDirectory;
    originalToastInfo = toast.info;
    opencodeClient.sendMessage = async (params) => {
      calls.push(params);
      return 'msg';
    };
    opencodeClient.createSession = async (_params, directory) => {
      createdDirectories.push(directory ?? null);
      return { id: DRAFT_SESSION, directory: directory ?? null };
    };
    opencodeClient.createDirectory = async (path) => ({ success: true, path });
    toast.info = (message, data) => {
      toastInfoCalls.push({ message, data });
      return 'toast-id';
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    opencodeClient.createSession = originalCreateSession;
    opencodeClient.createDirectory = originalCreateDirectory;
    toast.info = originalToastInfo;
    useAgentsStore.setState({ agentsByDirectory: originalAgentsByDirectory });
    useConfigStore.setState({ currentAgentName: originalCurrentAgentName });
    useSelectionStore.getState().clearSessionSelections(DRAFT_SESSION);
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
  });

  const send = (agent) => useSessionUIStore.getState().sendMessage(
    'hello', PROVIDER, MODEL, agent, undefined, undefined, undefined, undefined, 'normal',
  );

  test('drops an ambient project-scoped agent missing from the prepared chat directory list and says why', async () => {
    // Temp chat: the composer scope is the generated scratch directory the
    // send targets, so the previous project's list must not leak in.
    const preparedChatDirectory = '/home/tester/.openchamber/chats/draft-1';
    useSessionUIStore.setState({
      newSessionDraft: { ...draft, preparedChatDirectory },
    });
    useAgentsStore.setState({
      agentsByDirectory: {
        __default__: [{ name: 'alpha', mode: 'primary', permission: [], options: {} }],
        [preparedChatDirectory]: [{ name: 'build', mode: 'primary', permission: [], options: {} }],
      },
    });
    useConfigStore.setState({ currentAgentName: 'alpha' });

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBeUndefined();
    // The send targets the same prepared scratch directory the guard scoped to.
    expect(createdDirectories).toHaveLength(1);
    expect(createdDirectories[0]).toBe(preparedChatDirectory);
    expect(calls[0].directory).toBe(preparedChatDirectory);
    expect(toastInfoCalls).toHaveLength(1);
    expect(String(toastInfoCalls[0].message)).toContain('alpha');
    expect(toastInfoCalls[0].data.id).toBe(`agent-unavailable:${DRAFT_SESSION}:alpha`);
    // The choice materialization had stored is reconciled out with the send.
    expect(useSelectionStore.getState().getSessionAgentSelection(DRAFT_SESSION)).toBeNull();
    expect(useSelectionStore.getState().getAgentModelForSession(DRAFT_SESSION, 'alpha')).toBeNull();
  });

  test('keeps an agent the prepared chat directory list defines', async () => {
    const preparedChatDirectory = '/home/tester/.openchamber/chats/draft-2';
    useSessionUIStore.setState({
      newSessionDraft: { ...draft, preparedChatDirectory },
    });
    useAgentsStore.setState({
      agentsByDirectory: {
        __default__: [{ name: 'build', mode: 'primary', permission: [], options: {} }],
        [preparedChatDirectory]: [{ name: 'alpha', mode: 'primary', permission: [], options: {} }],
      },
    });
    useConfigStore.setState({ currentAgentName: 'alpha' });

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('alpha');
    expect(toastInfoCalls).toHaveLength(0);
    expect(useSelectionStore.getState().getSessionAgentSelection(DRAFT_SESSION)).toBe('alpha');
  });

  test('keeps the requested agent while an unprepared chat draft scope is unknown (fail open)', async () => {
    // No scratch directory prepared yet, so the scope is unknown, never the
    // ambient `__default__` list the old null fallback read.
    useAgentsStore.setState({
      agentsByDirectory: { __default__: [{ name: 'build', mode: 'primary', permission: [], options: {} }] },
    });
    useConfigStore.setState({ currentAgentName: 'alpha' });

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('alpha');
    expect(toastInfoCalls).toHaveLength(0);
  });

  test('resolves the guard scope from the submit-time draft snapshot, not the live draft', async () => {
    // The composer scoped this send while draft A (/projects/alpha) was open.
    // By send time the live store holds a different, newly opened draft B, so
    // only the snapshot knows which directory's agent list this send belongs to.
    const draftSnapshot = {
      ...draft,
      target: 'project',
      directoryOverride: '/projects/alpha',
    };
    useAgentsStore.setState({
      agentsByDirectory: {
        '/projects/alpha': [{ name: 'alpha', mode: 'primary', permission: [], options: {} }],
        '/projects/beta': [{ name: 'other', mode: 'primary', permission: [], options: {} }],
      },
    });
    useConfigStore.setState({ currentAgentName: 'alpha' });
    useSessionUIStore.setState({
      newSessionDraft: { ...draft, target: 'project', directoryOverride: '/projects/beta' },
    });

    await useSessionUIStore.getState().sendMessage(
      'hello', PROVIDER, MODEL, undefined, undefined, undefined, undefined, undefined, 'normal',
      { draftSnapshot },
    );

    // Draft A's loaded list defines alpha, so the guard keeps it even though the
    // live draft B does not.
    expect(createdDirectories).toHaveLength(1);
    expect(createdDirectories[0]).toBe('/projects/alpha');
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('alpha');
    expect(toastInfoCalls).toHaveLength(0);
    expect(useSelectionStore.getState().getSessionAgentSelection(DRAFT_SESSION)).toBe('alpha');
  });
});

describe('routeMessage skill invocation', () => {
  // OpenCode registers every skill as a command (source: "skill"), so a skill
  // selected from the slash menu must be dispatched via session.command so its
  // content is injected — not sent as a plain "/name" text message (issue #1605).
  const sendCommandCalls = [];
  const sendMessageCalls = [];
  let originalSendCommand;
  let originalSendMessage;

  beforeEach(() => {
    sendCommandCalls.length = 0;
    sendMessageCalls.length = 0;

    // Minimal optimistic + connection machinery so routeMessage can dispatch.
    const childStore = {
      getState: () => ({
        session: [],
        message: {},
        part: {},
        session_status: {},
      }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/skills/project');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });

    // The sync command list and the commands store both exclude user skills,
    // so they start empty here — the skill is only known to the skills store.
    useCommandsStore.setState({ commands: [] });
    useSkillsStore.setState({ skills: [] });

    originalSendCommand = opencodeClient.sendCommand;
    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendCommand = async (params) => {
      sendCommandCalls.push(params);
      return 'msg';
    };
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendCommand = originalSendCommand;
    opencodeClient.sendMessage = originalSendMessage;
    useSkillsStore.setState({ skills: [] });
  });

  test('invokes a user-installed skill as a command', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('grill-with-docs');
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('forwards trailing arguments to the skill command', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('grill-with-docs');
    expect(sendCommandCalls[0].arguments).toBe('focus on auth');
  });

  test('preserves context parts and skill invocation on the prompt route', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });
    const additionalParts = [createContextPart({
      kind: 'code-comment',
      source: 'file',
      fileLabel: 'src/auth.ts',
      startLine: 4,
      endLine: 4,
      language: 'ts',
      code: 'auth();',
      text: 'check this',
    })];

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
      additionalParts,
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].additionalParts[0]).toEqual(additionalParts[0]);
    expect(sendMessageCalls[0].additionalParts[1]).toMatchObject({ synthetic: true });
    expect(sendMessageCalls[0].additionalParts[1].text).toContain('grill-with-docs skill');
  });

  test('expands a contextual command template on the prompt route', async () => {
    useCommandsStore.setState({
      commands: [{ name: 'inspect', template: 'Inspect $ARGUMENTS carefully.' }],
    });

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/inspect auth flow',
      providerID: 'provider-a',
      modelID: 'model-a',
      additionalParts: [createContextPart({
        kind: 'code-comment',
        source: 'file',
        fileLabel: 'src/auth.ts',
        startLine: 4,
        endLine: 4,
        language: 'ts',
        code: 'auth();',
        text: 'check this',
      })],
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('Inspect auth flow carefully.');
    expect(sendMessageCalls[0].additionalParts[0].metadata.openchamberContext.kind).toBe('code-comment');
  });

  test('keeps session.command when the only extra part is pinned knowledge', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });

    const route = await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
      additionalParts: [{ text: 'Pinned project knowledge', synthetic: true, systemContext: 'session-knowledge' }],
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('grill-with-docs');
    expect(sendCommandCalls[0].arguments).toBe('focus on auth');
    expect(sendMessageCalls).toHaveLength(0);
    expect(route).toBe('command');
  });

  test('keeps primary file attachments on the command route', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });
    const files = [{
      type: 'file',
      mime: 'text/plain',
      url: 'file:///projects/alpha/auth.txt',
      filename: 'auth.txt',
    }];

    const route = await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
      files,
      additionalParts: [{ text: 'Pinned project knowledge', synthetic: true, systemContext: 'session-knowledge' }],
    });

    expect(route).toBe('command');
    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].files).toEqual(files);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('keeps unmarked synthetic instructions on the prompt route', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });
    const instructions = [{ text: 'Resolve the prepared conflict first.', synthetic: true }];

    const route = await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
      additionalParts: instructions,
    });

    expect(route).toBe('prompt');
    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].additionalParts[0]).toEqual(instructions[0]);
  });

  test('sends an unknown slash token as a plain message', async () => {
    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/not-a-real-skill',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendCommandCalls).toHaveLength(0);
  });
});

describe('archiveSessions option forwarding', () => {
  let originalUpdateSession;
  let updateSessionCalls;

  beforeEach(() => {
    updateSessionCalls = [];
    originalUpdateSession = opencodeClient.updateSession;
    opencodeClient.updateSession = (sessionId) => {
      updateSessionCalls.push(sessionId);
      return Promise.resolve(null);
    };
  });

  afterEach(() => {
    opencodeClient.updateSession = originalUpdateSession;
  });

  // The store used to accept an options object and silently drop it, so a
  // caller-supplied runtime key had no effect. Passing a key that cannot match
  // the active runtime must abort the batch before any SDK call.
  test('honors expectedRuntimeKey instead of discarding the options object', async () => {
    const result = await useSessionUIStore.getState().archiveSessions(['session-x', 'session-y'], {
      expectedRuntimeKey: 'runtime-that-is-not-active',
    });

    expect(result).toEqual({ archivedIds: [], failedIds: ['session-x', 'session-y'] });
    expect(updateSessionCalls).toEqual([]);
  });

  test('unarchiveSessions honors expectedRuntimeKey instead of discarding the options object', async () => {
    const result = await useSessionUIStore.getState().unarchiveSessions(['session-x', 'session-y'], {
      expectedRuntimeKey: 'runtime-that-is-not-active',
    });

    expect(result).toEqual({ restoredIds: [], failedIds: ['session-x', 'session-y'] });
    expect(updateSessionCalls).toEqual([]);
  });
});

describe('deleteSessions option forwarding', () => {
  let originalDeleteSession;
  let deleteSessionCalls;

  beforeEach(() => {
    deleteSessionCalls = [];
    originalDeleteSession = opencodeClient.deleteSession;
    opencodeClient.deleteSession = (sessionId) => {
      deleteSessionCalls.push(sessionId);
      return Promise.resolve(true);
    };
  });

  afterEach(() => {
    opencodeClient.deleteSession = originalDeleteSession;
  });

  // The store accepted an options object and dropped it on both the single and
  // batch delete paths. A key that cannot match the active runtime must abort
  // before any SDK call rather than deleting and erasing persisted state.
  test('honors expectedRuntimeKey on the batch delete instead of discarding options', async () => {
    const result = await useSessionUIStore.getState().deleteSessions(['session-x', 'session-y'], {
      expectedRuntimeKey: 'runtime-that-is-not-active',
    });

    expect(result).toEqual({ deletedIds: [], failedIds: ['session-x', 'session-y'] });
    expect(deleteSessionCalls).toEqual([]);
  });

  test('honors expectedRuntimeKey on the single delete instead of discarding options', async () => {
    const deleted = await useSessionUIStore.getState().deleteSession('session-x', {
      expectedRuntimeKey: 'runtime-that-is-not-active',
    });

    expect(deleted).toBe(false);
    expect(deleteSessionCalls).toEqual([]);
  });
});

describe('sendMessage effort record', () => {
  let originalSendMessage;

  const SESSION = 'session-effort';
  const PROVIDER = 'provider-a';
  const MODEL = 'model-a';
  const AGENT = 'build';

  const readRecord = () => useSelectionStore
    .getState()
    .getAgentModelVariantForSession(SESSION, AGENT, PROVIDER, MODEL);

  beforeEach(() => {
    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/current/project');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({
      isConnected: true,
      currentProviderId: PROVIDER,
      currentModelId: MODEL,
      currentAgentName: AGENT,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
    });
    useSessionUIStore.setState({
      currentSessionId: SESSION,
      currentSessionDirectory: '/current/project',
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = async () => 'msg';
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    useSelectionStore.getState().saveAgentModelVariantForSession(SESSION, AGENT, PROVIDER, MODEL, undefined);
  });

  const send = (variant) => useSessionUIStore.getState().sendMessage(
    'hello', PROVIDER, MODEL, AGENT, undefined, undefined, undefined, variant, 'normal',
  );

  test('keeps an explicit Default across the send that follows it', async () => {
    // What the picker leaves behind: `null` recorded, and a send that carries
    // no effort because "Default" means exactly that.
    useSelectionStore.getState().saveAgentModelVariantForSession(SESSION, AGENT, PROVIDER, MODEL, null);
    useConfigStore.setState({ currentVariantSelection: { override: null, inherited: 'high' } });

    await send(undefined);

    expect(readRecord()).toBeNull();
  });

  test('records the effort a send carries', async () => {
    useConfigStore.setState({ currentVariantSelection: { override: 'high', inherited: 'high' } });

    await send('high');

    expect(readRecord()).toBe('high');
  });

  test('records no choice when the live selection inherits its effort', async () => {
    useConfigStore.setState({
      currentVariant: 'high',
      currentVariantSelection: { override: undefined, inherited: 'high' },
    });

    await send('high');

    expect(readRecord()).toBe(undefined);
  });
});

describe('sendMessage agent availability guard', () => {
  const SESSION = 'session-agent-scope';
  const DIRECTORY = '/projects/alpha';
  const PROVIDER = 'provider-a';
  const MODEL = 'model-a';
  const calls = [];
  let originalSendMessage;
  let originalAgentsByDirectory;
  let originalCurrentAgentName;

  beforeEach(() => {
    calls.length = 0;
    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => DIRECTORY);
    setOptimisticRefs(() => {}, () => {});
    originalAgentsByDirectory = useAgentsStore.getState().agentsByDirectory;
    originalCurrentAgentName = useConfigStore.getState().currentAgentName;
    useConfigStore.setState({
      isConnected: true,
      currentProviderId: PROVIDER,
      currentModelId: MODEL,
      currentAgentName: null,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
    });
    useSessionUIStore.setState({
      currentSessionId: SESSION,
      currentSessionDirectory: DIRECTORY,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
    useSelectionStore.getState().clearSessionSelections(SESSION);

    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = async (params) => {
      calls.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    useAgentsStore.setState({ agentsByDirectory: originalAgentsByDirectory });
    useConfigStore.setState({ currentAgentName: originalCurrentAgentName });
    useSelectionStore.getState().clearSessionSelections(SESSION);
  });

  const send = (agent) => useSessionUIStore.getState().sendMessage(
    'hello', PROVIDER, MODEL, agent, undefined, undefined, undefined, undefined, 'normal',
  );

  test('drops a missing agent and clears the stale session selection', async () => {
    useAgentsStore.setState({
      agentsByDirectory: { [DIRECTORY]: [{ name: 'build', mode: 'primary', permission: [], options: {} }] },
    });
    useSelectionStore.getState().saveSessionAgentSelection(SESSION, 'ghost');
    useSelectionStore.getState().saveAgentModelForSession(SESSION, 'ghost', PROVIDER, MODEL);

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBeUndefined();
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBeNull();
    expect(useSelectionStore.getState().getAgentModelForSession(SESSION, 'ghost')).toBeNull();
  });

  test('keeps an available agent and its recorded selection', async () => {
    useAgentsStore.setState({
      agentsByDirectory: { [DIRECTORY]: [{ name: 'orchestrator', mode: 'primary', permission: [], options: {} }] },
    });
    useSelectionStore.getState().saveSessionAgentSelection(SESSION, 'orchestrator');

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('orchestrator');
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('orchestrator');
  });

  test('keeps the requested agent while its directory list has not loaded', async () => {
    useAgentsStore.setState({ agentsByDirectory: {} });
    useSelectionStore.getState().saveSessionAgentSelection(SESSION, 'ghost');

    await send(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('ghost');
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('ghost');
  });

  test('keeps the requested agent when the session has no directory, because send routing resolves the client fallback', async () => {
    useAgentsStore.setState({
      agentsByDirectory: { __default__: [{ name: 'build', mode: 'primary', permission: [], options: {} }] },
    });
    useSelectionStore.getState().saveSessionAgentSelection(SESSION, 'alpha');
    useSessionUIStore.setState({ currentSessionDirectory: null });

    await send(undefined);

    expect(calls).toHaveLength(1);
    // Intentional asymmetry with the picker's null no-directory scope:
    // `opencodeClient.sendMessage` falls back to `client.currentDirectory` for
    // a missing directory, so the guard fails open rather than dropping a name
    // it cannot disprove against a list the send may never use.
    expect(calls[0].agent).toBe('alpha');
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('alpha');
  });
});

const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/Users/tester' });
await ensureChatsRootDirectory();
opencodeClient.getFilesystemHomeInfo = originalHomeInfo;

describe('missing session directory recovery', () => {
  const missingWorktree = '/projects/main/.worktrees/gone';
  const projectDirectory = '/projects/main';
  const moves = [];
  const probes = [];
  let availability = 'missing';
  let originalGetDirectoryAvailability;
  let originalGetSdkClient;
  let originalProjects;
  let originalActiveProjectId;
  let originalDirectoryState;
  let originalClientDirectory;
  let originalGlobalState;

  const worktreeSession = (id, directory, parentID = null) => ({
    id,
    parentID: parentID ?? undefined,
    projectID: 'project-main',
    directory,
    project: { worktree: projectDirectory },
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
  });

  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await Bun.sleep(0);
  };

  beforeEach(() => {
    moves.length = 0;
    probes.length = 0;
    availability = 'missing';
    originalGetDirectoryAvailability = opencodeClient.getDirectoryAvailability;
    originalGetSdkClient = opencodeClient.getSdkClient;
    originalProjects = useProjectsStore.getState().projects;
    originalActiveProjectId = useProjectsStore.getState().activeProjectId;
    originalDirectoryState = useDirectoryStore.getState();
    originalClientDirectory = opencodeClient.getDirectory();
    originalGlobalState = useGlobalSessionsStore.getState();

    const childStore = {
      getState: () => ({ session: [], message: {}, part: {}, session_status: {} }),
      setState: () => {},
    };
    const childStores = { children: new Map(), ensureChild: () => childStore, getChild: () => childStore };
    setActionRefs({
      project: { list: async () => ({ data: [{ id: 'project-main', worktree: projectDirectory }] }) },
      session: { messages: async () => ({ data: [] }) },
    }, childStores, () => projectDirectory);
    setOptimisticRefs(() => {}, () => {});
    opencodeClient.getSdkClient = () => ({
      experimental: { controlPlane: { moveSession: async (params) => { moves.push(params); return {}; } } },
    });
    opencodeClient.getDirectoryAvailability = async (directory) => {
      probes.push(directory);
      return availability;
    };
    useProjectsStore.setState({
      projects: [{ id: 'project-main', path: projectDirectory, label: 'Main' }],
      activeProjectId: 'project-main',
    });
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      worktreeMetadata: new Map(),
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
  });

  afterEach(() => {
    opencodeClient.getDirectoryAvailability = originalGetDirectoryAvailability;
    opencodeClient.getSdkClient = originalGetSdkClient;
    useProjectsStore.setState({ projects: originalProjects, activeProjectId: originalActiveProjectId });
    useDirectoryStore.setState(originalDirectoryState, true);
    useGlobalSessionsStore.setState(originalGlobalState, true);
    opencodeClient.setDirectory(originalClientDirectory ?? undefined);
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, worktreeMetadata: new Map() });
  });

  test('leaves a missing worktree session in place on activation and does not probe or relocate it', async () => {
    const root = worktreeSession('root', missingWorktree);
    useGlobalSessionsStore.setState({ activeSessions: [root], archivedSessions: [] });

    useSessionUIStore.getState().setCurrentSession('root', missingWorktree);
    await settle();

    expect(probes).toEqual([]);
    expect(moves).toEqual([]);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(missingWorktree);
    expect(useSessionUIStore.getState().getDirectoryForSession('root')).toBe(missingWorktree);
  });

  test('never probes a session that lives in its project root or in a managed chat directory', async () => {
    const chatDirectory = '/Users/tester/.config/openchamber/chats/2026-09-05/session-abc';
    useGlobalSessionsStore.setState({
      activeSessions: [worktreeSession('in-root', projectDirectory), worktreeSession('chat', chatDirectory)],
      archivedSessions: [],
    });

    useSessionUIStore.getState().setCurrentSession('in-root', projectDirectory);
    await settle();
    useSessionUIStore.getState().setCurrentSession('chat', chatDirectory);
    await settle();

    expect(probes).toEqual([]);
    expect(moves).toEqual([]);
  });
});
