import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

describe('VS Code webview git API', () => {
  const target = new EventTarget();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAcquire = Object.getOwnPropertyDescriptor(globalThis, 'acquireVsCodeApi');
  let postMessageHandler: (message: { id?: string; type: string; payload?: unknown }) => void = () => {};

  before(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      configurable: true,
      value: () => ({
        postMessage: (message: { id?: string; type: string; payload?: unknown }) => postMessageHandler(message),
        getState: () => undefined,
        setState: () => undefined,
      }),
    });
  });

  after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalAcquire) Object.defineProperty(globalThis, 'acquireVsCodeApi', originalAcquire);
    else Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
  });

  test('diff answers from the extension host become the shared contract, and unavailable paths become typed errors', async () => {
    const answers: unknown[] = [];
    postMessageHandler = (message) => {
      if (!message.id) return;
      const data = answers.shift();
      queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data: { id: message.id, type: message.type, success: true, data } })));
    };

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
  });

  test('exposes git history methods and transports the all selector', async () => {
    const messages: Array<{ id?: string; type: string; payload?: unknown }> = [];
    postMessageHandler = (message) => messages.push(message);

    const { createVSCodeGitAPI } = await import('./git');
    const api = createVSCodeGitAPI();
    assert.equal(typeof api.createGitTag, 'function');
    assert.equal(typeof api.getGitHistoryRefs, 'function');
    assert.equal(typeof api.getGitHistory, 'function');
    assert.equal(typeof api.getGitHistoryMergeBase, 'function');

    const createTagPromise = api.createGitTag?.('/repo', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567');
    const createTagRequest = messages.at(-1);
    assert.equal(createTagRequest?.type, 'api:git/tags');
    assert.deepEqual(createTagRequest?.payload, {
      directory: '/repo',
      method: 'POST',
      name: 'v1.2.3',
      commitHash: '0123456789abcdef0123456789abcdef01234567',
    });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: {
        id: createTagRequest?.id,
        type: createTagRequest?.type,
        success: true,
        data: { success: true, tag: 'v1.2.3' },
      },
    }));
    await createTagPromise;

    const refsPromise = api.getGitHistoryRefs?.('/repo');
    const refsRequest = messages.at(-1);
    assert.equal(refsRequest?.type, 'api:git/history/refs');
    assert.deepEqual(refsRequest?.payload, { directory: '/repo' });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: { id: refsRequest?.id, type: refsRequest?.type, success: true, data: { refs: [], current: null, upstream: null, base: null, snapshot: 'snap' } },
    }));
    await refsPromise;

    const historyPromise = api.getGitHistory?.('/repo', { all: true, limit: 25 });
    const historyRequest = messages.at(-1);
    assert.equal(historyRequest?.type, 'api:git/history');
    assert.deepEqual(historyRequest?.payload, { directory: '/repo', all: true, limit: 25 });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: { id: historyRequest?.id, type: historyRequest?.type, success: true, data: { items: [], nextCursor: null, hasMore: false, refsSnapshot: 'snap' } },
    }));
    await historyPromise;

    const mergeBasePromise = api.getGitHistoryMergeBase?.('/repo', { refs: ['HEAD', 'refs/heads/main'] });
    const mergeBaseRequest = messages.at(-1);
    assert.equal(mergeBaseRequest?.type, 'api:git/history/merge-base');
    assert.deepEqual(mergeBaseRequest?.payload, { directory: '/repo', refs: ['HEAD', 'refs/heads/main'] });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: { id: mergeBaseRequest?.id, type: mergeBaseRequest?.type, success: true, data: { mergeBase: 'abc1234' } },
    }));
    await mergeBasePromise;

    const commitHash = 'a'.repeat(40);
    const parentHash = 'b'.repeat(40);
    const commitFilesPromise = api.getCommitFiles?.('/repo', {
      commitHash,
      parentHash,
    });
    const commitFilesRequest = messages.at(-1);
    assert.equal(commitFilesRequest?.type, 'api:git/commit-files');
    assert.deepEqual(commitFilesRequest?.payload, {
      directory: '/repo',
      hash: commitHash,
      parentHash,
    });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: {
        id: commitFilesRequest?.id,
        type: commitFilesRequest?.type,
        success: true,
        data: { files: [] },
      },
    }));
    await commitFilesPromise;

    const commitPreviewPromise = api.getCommitFileDiff?.('/repo', {
      commitHash,
      parentHash,
      originalPath: 'old/name.ts',
      modifiedPath: 'new/name.ts',
    });
    const commitPreviewRequest = messages.at(-1);
    assert.equal(commitPreviewRequest?.type, 'api:git/commit-file-diff');
    assert.deepEqual(commitPreviewRequest?.payload, {
      directory: '/repo',
      hash: commitHash,
      parentHash,
      originalPath: 'old/name.ts',
      modifiedPath: 'new/name.ts',
    });
    globalThis.window.dispatchEvent(new MessageEvent('message', {
      data: {
        id: commitPreviewRequest?.id,
        type: commitPreviewRequest?.type,
        success: true,
        data: { status: 'too-large', totalBytes: 8388609, maxBytes: 8388608 },
      },
    }));
    await commitPreviewPromise;
  });
});
