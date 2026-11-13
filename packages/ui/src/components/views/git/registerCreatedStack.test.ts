import { expect, test } from 'bun:test';
import type { ChangeRequestStatus, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import { CreatedStackUnavailableError, registerCreatedStack } from './registerCreatedStack';

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo-id',
  accountId: 'account', bindingRevision: 3, primaryRemote: 'origin',
};
const project = { ...context, id: 'me/app', owner: 'me', name: 'app', url: 'https://github.com/me/app' };
const status: ChangeRequestStatus = { identity: context, branch: 'upper', project,
  changeRequest: { ...context, project, id: 'me/app#8', number: 8, title: 'Upper layer',
    url: `${project.url}/pull/8`, state: 'open', draft: false, head: 'upper', base: 'lower', headSha: 'b'.repeat(40) },
};
const created = { context, project: { owner: 'me', name: 'app' }, number: 8, head: 'upper', base: 'lower', createKey: 'create-8',
  stacked: undefined, isCurrent: () => true };

function service(read = status) {
  const writes: Parameters<SourceControlAPI['githubPullStackRegister']>[] = [];
  const reads: Parameters<SourceControlAPI['changeRequestStatus']>[] = [];
  const api: Pick<SourceControlAPI, 'changeRequestStatus' | 'githubPullStackRegister'> = {
    changeRequestStatus: async (...args) => { reads.push(args); return read; },
    githubPullStackRegister: async (...args) => { writes.push(args); return { ok: true, registered: true, nativeNumber: 4 }; },
  };
  return { api, reads, writes };
}

test('registers a created layer with the authoritative head when native create did not report stacking', async () => {
  // Given
  const { api, reads, writes } = service();

  // When
  const result = await registerCreatedStack(api, created);

  // Then
  expect(reads).toEqual([[context, 'upper', { force: true }]]);
  expect(writes).toEqual([[{ ...context, idempotencyKey: 'create-8:stack-register',
    target: { project: created.project, number: 8, head: 'upper', base: 'lower', headSha: 'b'.repeat(40) },
  }, { owner: 'me', repo: 'app', number: 8 }]]);
  expect(result?.registered).toBe(true);
});

for (const stacked of [true, false]) test(`leaves the native stack outcome ${stacked} authoritative without a second registration`, async () => {
  // Given
  const { api, reads, writes } = service();

  // When
  await registerCreatedStack(api, { ...created, stacked });

  // Then
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

for (const changeRequest of [null, status.changeRequest && { ...status.changeRequest, number: 9 },
  status.changeRequest && { ...status.changeRequest, base: 'main' }]) test('refuses registration when the read identifies a different layer', async () => {
  // Given
  const { api, writes } = service({ ...status, changeRequest });

  // When / Then
  await expect(registerCreatedStack(api, created)).rejects.toBeInstanceOf(CreatedStackUnavailableError);
  expect(writes).toHaveLength(0);
});

test('does not register on a new runtime after the status read completes', async () => {
  // Given
  let current = true;
  const { api, writes } = service();
  const read = api.changeRequestStatus;
  api.changeRequestStatus = async (...args) => { const result = await read(...args); current = false; return result; };

  // When
  await registerCreatedStack(api, { ...created, isCurrent: () => current });

  // Then
  expect(writes).toHaveLength(0);
});
