// @ts-expect-error Bun provides bun:test in isolated test runs for this workspace.
import { beforeEach, describe, expect, test, mock } from 'bun:test';

const gitServiceMocks = {
  createTag: mock(async () => ({ success: true, tag: 'v1.2.3' })),
};

mock.module('./gitService', () => gitServiceMocks);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('VS Code git bridge tag mutations', () => {
  beforeEach(() => {
    gitServiceMocks.createTag.mockClear();
  });

  test('routes create tag requests to gitService', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/tags',
      payload: {
        directory: '/repo',
        method: 'POST',
        name: 'v1.2.3',
        commitHash: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(gitServiceMocks.createTag).toHaveBeenCalledWith('/repo', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567');
    expect(response).toEqual({
      id: '1',
      type: 'api:git/tags',
      success: true,
      data: { success: true, tag: 'v1.2.3' },
    });
  });

  test('rejects invalid create tag payloads before invoking gitService', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/tags',
      payload: {
        directory: '/repo',
        method: 'POST',
        name: 'v1.2.3',
        commitHash: 'not-a-hash',
      },
    });

    expect(gitServiceMocks.createTag).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: '2',
      type: 'api:git/tags',
      success: false,
      error: 'commitHash must be a commit SHA',
    });
  });

  test('rejects option-like tag names before invoking gitService', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/tags',
      payload: {
        directory: '/repo',
        method: 'POST',
        name: '-d',
        commitHash: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(gitServiceMocks.createTag).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: '3',
      type: 'api:git/tags',
      success: false,
      error: 'Tag name must not contain option-like values',
    });
  });

  test('rejects NUL-delimited tag names before invoking gitService', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/tags',
      payload: {
        directory: '/repo',
        method: 'POST',
        name: 'bad\0tag',
        commitHash: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(gitServiceMocks.createTag).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: '4',
      type: 'api:git/tags',
      success: false,
      error: 'Tag name must not contain option-like values',
    });
  });
});
