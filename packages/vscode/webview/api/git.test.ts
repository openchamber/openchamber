import assert from 'node:assert/strict';
import { test } from 'node:test';

test('diff answers from the extension host become the shared contract, and unavailable paths become typed errors', async () => {
  const originalWindow = globalThis.window;
  const originalAcquire = Object.getOwnPropertyDescriptor(globalThis, 'acquireVsCodeApi');
  const target = new EventTarget();
  const answers: unknown[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      postMessage: (message: { id?: string; type: string }) => {
        if (!message.id) return;
        const data = answers.shift();
        queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data: { id: message.id, type: message.type, success: true, data } })));
      },
      getState: () => undefined,
      setState: () => undefined,
    }),
  });

  try {
    const { createVSCodeGitAPI } = await import('./git');
    const { GitPathUnavailableError } = await import('@openchamber/ui/lib/api/git-path-diff');
    const git = createVSCodeGitAPI();
    const submodule = { headCommit: 'a'.repeat(40), indexCommit: 'a'.repeat(40), worktreeCommit: 'b'.repeat(40), hasTrackedChanges: false, hasUntrackedFiles: false, hasConflict: false };

    answers.push({ kind: 'diff', diff: 'patch', submodule });
    assert.deepEqual(await git.getGitDiff('/repo', { path: 'sub' }), { diff: 'patch', submodule });

    answers.push({ kind: 'file-diff', original: 'a', modified: 'b', path: 'file.ts', submodule: null });
    assert.deepEqual(await git.getGitFileDiff('/repo', { path: 'file.ts' }), { original: 'a', modified: 'b', path: 'file.ts', submodule: null });

    answers.push({ kind: 'unavailable', reason: 'nested_repository', message: 'Path is a separate Git repository: nested/' });
    await assert.rejects(git.getGitDiff('/repo', { path: 'nested/' }), (error) => error instanceof GitPathUnavailableError && error.reason === 'nested_repository');

    answers.push({ kind: 'unavailable', reason: 'path_not_found', message: 'Path not found in working tree, index, or HEAD: gone.txt' });
    await assert.rejects(git.getGitFileDiff('/repo', { path: 'gone.txt' }), (error) => error instanceof GitPathUnavailableError && error.reason === 'path_not_found');

    // An old extension host answering the bare `{ diff }` shape is a contract break, not an empty diff.
    answers.push({ diff: '' });
    await assert.rejects(git.getGitDiff('/repo', { path: 'file.ts' }));
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    if (originalAcquire) Object.defineProperty(globalThis, 'acquireVsCodeApi', originalAcquire);
    else Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
  }
});
