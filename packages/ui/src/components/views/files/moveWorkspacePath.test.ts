import { beforeEach, describe, expect, test } from 'bun:test';

import { FilesystemError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import { isFilePathMoveInFlight, subscribeToFilePathMoves } from '@/lib/filePathMoves';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

import { moveWorkspacePath } from './moveWorkspacePath';

const createFiles = (rename: NonNullable<FilesAPI['rename']>): FilesAPI => ({
  listDirectory: async () => ({ directory: '/repo', entries: [] }),
  search: async () => [],
  createDirectory: async (path) => ({ success: true, path }),
  rename,
});

const fileTabPaths = () => (useUIStore.getState().contextPanelByDirectory['/repo']?.tabs ?? [])
  .filter((tab) => tab.mode === 'file')
  .map((tab) => tab.targetPath);

describe('moveWorkspacePath', () => {
  beforeEach(() => {
    useUIStore.setState({ contextPanelByDirectory: {} });
    useFilesViewTabsStore.setState({ byRoot: {} });
    useUIStore.getState().openContextFile('/repo', '/repo/src/a.ts');
    useFilesViewTabsStore.getState().setSelectedPath('/repo', '/repo/src/a.ts');
  });

  test('holds saves during the request, then tells the editor and moves the tabs', async () => {
    const heldDuringRequest: boolean[] = [];
    const notified: Array<{ from: string; to: string }> = [];
    const unsubscribe = subscribeToFilePathMoves(({ from, to }) => {
      notified.push({ from, to });
      // The editor hears about the move before the tabs point at the new path.
      expect(fileTabPaths()).toEqual(['/repo/src/a.ts']);
    });
    const files = createFiles(async (_oldPath, newPath) => {
      heldDuringRequest.push(isFilePathMoveInFlight('/repo/src/a.ts'));
      return { success: true, path: newPath };
    });

    const result = await moveWorkspacePath(files, '/repo', '/repo/src/a.ts', '/repo/lib/a.ts');
    unsubscribe();

    expect(result).toBe('moved');
    expect(heldDuringRequest).toEqual([true]);
    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(false);
    expect(notified).toEqual([{ from: '/repo/src/a.ts', to: '/repo/lib/a.ts' }]);
    expect(fileTabPaths()).toEqual(['/repo/lib/a.ts']);
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.selectedPath).toBe('/repo/lib/a.ts');
  });

  test('reports a name conflict and leaves tabs and the editor alone', async () => {
    let notified = 0;
    const unsubscribe = subscribeToFilePathMoves(() => { notified += 1; });
    const files = createFiles(async () => {
      throw new FilesystemError('Destination already exists', { reason: 'already-exists', status: 409 });
    });

    const result = await moveWorkspacePath(files, '/repo', '/repo/src/a.ts', '/repo/lib/a.ts');
    unsubscribe();

    expect(result).toBe('conflict');
    expect(notified).toBe(0);
    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(false);
    expect(fileTabPaths()).toEqual(['/repo/src/a.ts']);
  });

  test('reports any other failure as failed', async () => {
    const files = createFiles(async () => {
      throw new Error('Access denied');
    });

    expect(await moveWorkspacePath(files, '/repo', '/repo/src/a.ts', '/repo/lib/a.ts')).toBe('failed');
    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(false);
    expect(fileTabPaths()).toEqual(['/repo/src/a.ts']);
  });
});
