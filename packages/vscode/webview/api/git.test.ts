import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('VS Code webview git API', () => {
  test('exposes git history methods and transports commit metadata object requests', async () => {
    const originalWindow = globalThis.window;
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: Array<{ id: string; type: string; payload?: Record<string, unknown> }> = [];

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: new EventTarget(),
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage: (message: { id: string; type: string; payload?: Record<string, unknown> }) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { createVSCodeGitAPI } = await import(`./git?history-api-${Date.now()}`);
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

      const commitFilesPromise = api.getCommitFiles?.('/repo', {
        commitHash: 'abc123',
        parentHash: 'def456',
      });
      const commitFilesRequest = messages.at(-1);
      assert.equal(commitFilesRequest?.type, 'api:git/commit-files');
      assert.deepEqual(commitFilesRequest?.payload, {
        directory: '/repo',
        hash: 'abc123',
        parentHash: 'def456',
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
        commitHash: 'abc123',
        parentHash: 'def456',
        originalPath: 'old/name.ts',
        modifiedPath: 'new/name.ts',
      });
      const commitPreviewRequest = messages.at(-1);
      assert.equal(commitPreviewRequest?.type, 'api:git/commit-file-diff');
      assert.deepEqual(commitPreviewRequest?.payload, {
        directory: '/repo',
        hash: 'abc123',
        parentHash: 'def456',
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
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
