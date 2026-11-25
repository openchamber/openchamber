import { afterEach, expect, spyOn, test } from 'bun:test';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import * as worktreeManager from '@/lib/worktrees/worktreeManager';
import { resolveWorktreeExecution } from './todoSendExecution';

const execution = {
  providerID: 'new', modelID: 'desired', variant: 'high', agent: 'build',
  picked: { model: true, variant: true, agent: true },
};

const project = { id: 'project-1', path: '/test' };
const created = { id: 'ses_new', directory: '/test/worktree', path: '/test/worktree', branch: 'quiet-otter', previousDirectory: '/test' };

afterEach(() => {
  spyOn(sessionActions, 'deleteSession').mockRestore();
  spyOn(worktreeManager, 'removeProjectWorktree').mockRestore();
  spyOn(opencodeClient, 'switchSessionModel').mockRestore();
  spyOn(toast, 'error').mockRestore();
});

test('a failed new-worktree model switch tells the user and returns no execution to send', async () => {
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  const toastError = spyOn(toast, 'error').mockImplementation(() => 'toast');
  spyOn(sessionActions, 'deleteSession').mockImplementation(async () => true);
  spyOn(worktreeManager, 'removeProjectWorktree').mockImplementation(async () => undefined);

  expect(await resolveWorktreeExecution(project, created, execution)).toBeNull();
  expect(switchModel.mock.calls).toEqual([['ses_new', { providerID: 'new', id: 'desired', variant: 'high' }, '/test/worktree']]);
  expect(toastError.mock.calls).toEqual([['Could not switch the model']]);
});

test('a successful new-worktree model switch returns the execution to send', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => undefined);
  const toastError = spyOn(toast, 'error').mockImplementation(() => 'toast');

  expect(await resolveWorktreeExecution(project, created, execution)).toEqual(execution);
  expect(toastError).not.toHaveBeenCalled();
});
