import { describe, expect, test } from 'bun:test';

import { normalizePath } from './pathNormalization';
import { selectLoadedAgentsForDirectory } from '@/stores/useAgentsStore';
import type { AgentWithExtras } from '@/stores/useAgentsStore';
import { resolveComposerAgentDirectory } from './composerAgentDirectory';

describe('resolveComposerAgentDirectory', () => {
  const draft = {
    open: true,
    bootstrapPendingDirectory: null,
    directoryOverride: null,
    preparedChatDirectory: null,
  };

  test('a resolving session directory is used, normalized', () => {
    expect(resolveComposerAgentDirectory({
      sessionId: 'session-a',
      sessionDirectory: 'C:\\Repo\\feature\\',
      sessionIsKnown: true,
      draft: null,
    })).toBe('C:/Repo/feature');
  });

  test('a known session with no directory scopes to the no-directory list', () => {
    // The #3420 repro: a temp-chat session exists but has no project
    // directory, so the ambient project must not leak into the picker.
    expect(resolveComposerAgentDirectory({
      sessionId: 'session-chat',
      sessionDirectory: null,
      sessionIsKnown: true,
      draft: null,
    })).toBeNull();
  });

  test('an unknown session identity fails open', () => {
    expect(resolveComposerAgentDirectory({
      sessionId: 'session-late',
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: null,
    })).toBeUndefined();
  });

  test('an open draft with no resolvable directory is unknown and fails open', () => {
    // Drafts never become `null`: `listAgents(null)` would read the client's
    // ambient project, not the directory the send targets.
    expect(resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft,
    })).toBeUndefined();
  });

  test('an open chat draft resolves its prepared scratch directory, normalized', () => {
    expect(resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: { ...draft, preparedChatDirectory: 'C:\\Chats\\draft-1\\' },
    })).toBe('C:/Chats/draft-1');
  });

  test('draft scope prefers bootstrap, then override, then the prepared chat directory', () => {
    const withAll = {
      ...draft,
      bootstrapPendingDirectory: '/repo/worktrees/pending',
      directoryOverride: '/repo/worktrees/override',
      preparedChatDirectory: '/chats/draft-1',
    };
    const base = { sessionId: null, sessionDirectory: null, sessionIsKnown: false };

    expect(resolveComposerAgentDirectory({ ...base, draft: withAll })).toBe('/repo/worktrees/pending');
    expect(resolveComposerAgentDirectory({
      ...base,
      draft: { ...withAll, bootstrapPendingDirectory: null },
    })).toBe('/repo/worktrees/override');
    expect(resolveComposerAgentDirectory({
      ...base,
      draft: { ...withAll, bootstrapPendingDirectory: null, directoryOverride: null },
    })).toBe('/chats/draft-1');
  });

  test('an open draft directory is used, normalized', () => {
    expect(resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: { ...draft, directoryOverride: '/repo/worktrees/feat-a/' },
    })).toBe('/repo/worktrees/feat-a');
  });

  test('no session and no open draft fails open', () => {
    expect(resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: null,
    })).toBeUndefined();
    expect(resolveComposerAgentDirectory({
      sessionId: null,
      sessionDirectory: null,
      sessionIsKnown: false,
      draft: { ...draft, open: false, directoryOverride: '/repo' },
    })).toBeUndefined();
  });

  test('picker and send guard resolve one normalized agentsByDirectory key', () => {
    // The send guard normalizes its lookup with `normalizePath`; the picker
    // must land on the same entry for the same raw path.
    const rawDirectory = 'C:\\Repo\\feature\\';
    const guardKey = normalizePath(rawDirectory) ?? '';
    const buildAgent: AgentWithExtras = { name: 'build', mode: 'primary', permission: [], options: {} };
    const agentsByDirectory = { [guardKey]: [buildAgent] };

    const pickerDirectory = resolveComposerAgentDirectory({
      sessionId: 'session-worktree',
      sessionDirectory: rawDirectory,
      sessionIsKnown: true,
      draft: null,
    });

    expect(pickerDirectory).toBe(guardKey);
    expect(selectLoadedAgentsForDirectory({ agentsByDirectory }, pickerDirectory)).toBe(
      agentsByDirectory[guardKey],
    );
  });
});
