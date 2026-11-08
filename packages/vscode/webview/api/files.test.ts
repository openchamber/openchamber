import { describe, expect, mock, test } from 'bun:test';

const calls: unknown[][] = [];
const send = async (...args: unknown[]) => {
  calls.push(args);
  return { files: [{ path: 'C:\\repo\\build\\a.ts', relativePath: 'build/a.ts' }] };
};
mock.module('./bridge', () => ({ sendBridgeMessage: mock(), searchFilesRequest: send, sendBridgeMessageWithOptions: mock() }));
const { createVSCodeFilesAPI } = await import('./files');

describe('VS Code file search', () => {
  test('forwards both toggles and normalizes the bridge results', async () => {
    expect(await createVSCodeFilesAPI().search({ directory: 'C:/repo', query: 'a', includeHidden: true, respectGitignore: false }))
      .toEqual([{ path: 'C:/repo/build/a.ts', preview: ['build/a.ts'] }]);
    expect(calls.at(-1)).toEqual([{
      directory: 'C:/repo', query: 'a', limit: undefined, includeHidden: true, respectGitignore: false,
    }, undefined]);
  });

  test('hands the caller\'s signal to the bridge request', async () => {
    const { signal } = new AbortController();
    await createVSCodeFilesAPI().search({ directory: 'C:/repo', query: 'a', includeHidden: true, signal });
    expect(calls.at(-1)?.[1]).toBe(signal);
  });
});
