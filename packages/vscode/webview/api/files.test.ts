import { describe, expect, mock, test } from 'bun:test';

const calls: unknown[][] = [];
const send = async (...args: unknown[]) => {
  calls.push(args);
  return { files: [{ path: 'C:\\repo\\build\\a.ts', relativePath: 'build/a.ts' }] };
};
mock.module('./bridge', () => ({ sendBridgeMessage: send, sendBridgeMessageWithOptions: mock() }));
const { createVSCodeFilesAPI } = await import('./files');

describe('VS Code file search', () => {
  test('forwards both toggles and normalizes the bridge results', async () => {
    expect(await createVSCodeFilesAPI().search({ directory: 'C:/repo', query: 'a', includeHidden: true, respectGitignore: false }))
      .toEqual([{ path: 'C:/repo/build/a.ts', preview: ['build/a.ts'] }]);
    expect(calls.at(-1)).toEqual(['api:fs:search', {
      directory: 'C:/repo', query: 'a', limit: undefined, includeHidden: true, respectGitignore: false,
    }]);
  });
});
