import { describe, expect, test } from 'bun:test';

import { buildScheduledTaskPayload, toDraft, type ScheduledTaskDraft } from './scheduledTaskEditorDraft';

const defaults = { providerID: 'provider-x', modelID: 'model-x', variant: '', agent: '' };

const baseTask = {
  id: 'task-1',
  name: 'Nightly sweep',
  enabled: true,
  targetSessionId: undefined,
  schedule: { kind: 'daily' as const, times: ['09:00'] },
  execution: { prompt: 'sweep', providerID: 'p', modelID: 'm' },
  state: { createdAt: 1, updatedAt: 1 },
};

describe('scheduledTaskEditorDraft.toDraft', () => {
  test('defaults carry isolation off with no base branch', () => {
    const draft = toDraft(null, defaults);
    expect(draft.runInWorktree).toBe(false);
    expect(draft.baseBranch).toBe('');
  });

  test('keeps the stored isolation fields of a project-scope task', () => {
    const draft = toDraft({ ...baseTask, runInWorktree: true, baseBranch: ' release/10 ' } as never, defaults);
    expect(draft.runInWorktree).toBe(true);
    expect(draft.baseBranch).toBe(' release/10 ');
  });

  test('an absent field reads as isolation off', () => {
    const draft = toDraft(baseTask as never, defaults);
    expect(draft.runInWorktree).toBe(false);
    expect(draft.baseBranch).toBe('');
  });
});

describe('scheduledTaskEditorDraft.buildScheduledTaskPayload', () => {
  test('sends the isolation fields only for a project-scope task', () => {
    const draft: ScheduledTaskDraft = {
      ...toDraft(baseTask as never, defaults),
      runInWorktree: true,
      baseBranch: 'release/10',
    };
    const payload = buildScheduledTaskPayload(draft);
    expect(payload.runInWorktree).toBe(true);
    expect(payload.baseBranch).toBe('release/10');
  });

  test('a chats-scope task never carries the fields', () => {
    const draft: ScheduledTaskDraft = {
      ...toDraft(null, defaults),
      sessionMode: 'existing',
      targetSessionId: 'ses-1',
      runInWorktree: true,
      baseBranch: 'release/10',
    };
    const payload = buildScheduledTaskPayload(draft);
    expect(payload.targetSessionId).toBe('ses-1');
    expect('runInWorktree' in payload).toBe(false);
    expect('baseBranch' in payload).toBe(false);
  });

  test('turning isolation off persists the switch but keeps the chosen branch', () => {
    const draft: ScheduledTaskDraft = {
      ...toDraft(null, defaults),
      runInWorktree: false,
      baseBranch: '  release/10  ',
    };
    const payload = buildScheduledTaskPayload(draft);
    expect(payload.runInWorktree).toBe(false);
    expect(payload.baseBranch).toBe('release/10');
  });

  test('an empty base branch is sent as an explicit clear', () => {
    const draft: ScheduledTaskDraft = {
      ...toDraft(null, defaults),
      runInWorktree: true,
      baseBranch: '   ',
    };
    const payload = buildScheduledTaskPayload(draft);
    expect(payload.runInWorktree).toBe(true);
    expect(payload.baseBranch).toBe('');
  });

  test('cleanup defaults on and is sent with the isolation fields', () => {
    const fresh = buildScheduledTaskPayload({
      ...toDraft(null, defaults),
      runInWorktree: true,
      baseBranch: 'main',
    });
    expect(fresh.cleanupWorktree).toBe(true);

    const keeping = buildScheduledTaskPayload({
      ...toDraft(null, defaults),
      runInWorktree: true,
      baseBranch: 'main',
      cleanupWorktree: false,
    });
    expect(keeping.cleanupWorktree).toBe(false);
  });

  test('a task that keeps its worktree reads back as cleanup off', () => {
    const draft = toDraft({ ...baseTask, cleanupWorktree: false } as never, defaults);
    expect(draft.cleanupWorktree).toBe(false);
    // Absent means cleanup, which is what isolation did before the field existed.
    expect(toDraft(baseTask as never, defaults).cleanupWorktree).toBe(true);
  });

  test('a chats-scope task never carries the cleanup choice either', () => {
    const draft: ScheduledTaskDraft = {
      ...toDraft(null, defaults),
      sessionMode: 'existing',
      targetSessionId: 'ses-1',
      runInWorktree: true,
      cleanupWorktree: false,
    };
    const payload = buildScheduledTaskPayload(draft);
    expect('cleanupWorktree' in payload).toBe(false);
  });
});
