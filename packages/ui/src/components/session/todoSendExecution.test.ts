import { afterEach, expect, spyOn, test } from 'bun:test';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { resolveWorktreeExecution } from './todoSendExecution';

const execution = {
  providerID: 'new', modelID: 'desired', variant: 'high', agent: 'build',
  picked: { model: true, variant: true, agent: true },
};

afterEach(() => {
  spyOn(opencodeClient, 'switchSessionModel').mockRestore();
  spyOn(toast, 'error').mockRestore();
});

test('a failed new-worktree model switch tells the user and returns no execution to send', async () => {
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  const toastError = spyOn(toast, 'error').mockImplementation(() => 'toast');

  expect(await resolveWorktreeExecution('ses_new', '/test/worktree', execution)).toBeNull();
  expect(switchModel.mock.calls).toEqual([['ses_new', { providerID: 'new', id: 'desired', variant: 'high' }, '/test/worktree']]);
  expect(toastError.mock.calls).toEqual([['Could not switch the model']]);
});

test('a successful new-worktree model switch returns the execution to send', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => undefined);
  const toastError = spyOn(toast, 'error').mockImplementation(() => 'toast');

  expect(await resolveWorktreeExecution('ses_new', '/test/worktree', execution)).toEqual(execution);
  expect(toastError).not.toHaveBeenCalled();
});
