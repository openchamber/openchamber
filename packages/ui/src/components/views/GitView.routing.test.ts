import { describe, expect, test } from 'bun:test';

import { getWorkingTreeDiffDestination } from '@/lib/getWorkingTreeDiffDestination';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { createGitContextCommitDetailsController } from './git/gitContextCommitDetailsController';
import { getGitViewRenderMode } from './git/gitViewRenderMode';

describe('getWorkingTreeDiffDestination', () => {
  test('routes combined desktop review to the main diff surface', () => {
    expect(getWorkingTreeDiffDestination({
      reviewLayout: 'combined',
      isMobile: false,
      isVSCode: false,
    })).toBe('main');
  });

  test('keeps separate, mobile, and VS Code review in the context diff surface', () => {
    expect(getWorkingTreeDiffDestination({
      reviewLayout: 'separate',
      isMobile: false,
      isVSCode: false,
    })).toBe('context');
    expect(getWorkingTreeDiffDestination({
      reviewLayout: 'combined',
      isMobile: true,
      isVSCode: false,
    })).toBe('context');
    expect(getWorkingTreeDiffDestination({
      reviewLayout: 'combined',
      isMobile: false,
      isVSCode: true,
    })).toBe('context');
  });
});

describe('getGitViewRenderMode', () => {
  test('uses legacy inline composition for narrow hosted web even when isMobile is false', () => {
    expect(getGitViewRenderMode({
      screenWidth: 390,
      isMobile: false,
      isDesktopShell: false,
      isVSCode: false,
    })).toBe('legacy-inline');
  });

  test('keeps workspace panes for narrow Electron windows', () => {
    expect(getGitViewRenderMode({
      screenWidth: 390,
      isMobile: false,
      isDesktopShell: true,
      isVSCode: false,
    })).toBe('workspace-panes');
  });

  test('uses workspace panes for normal-width desktop web and Electron', () => {
    expect(getGitViewRenderMode({
      screenWidth: 1280,
      isMobile: false,
      isDesktopShell: false,
      isVSCode: false,
    })).toBe('workspace-panes');
    expect(getGitViewRenderMode({
      screenWidth: 1280,
      isMobile: false,
      isDesktopShell: true,
      isVSCode: false,
    })).toBe('workspace-panes');
  });

  test('uses legacy inline composition for mobile and VS Code', () => {
    expect(getGitViewRenderMode({
      screenWidth: 390,
      isMobile: true,
      isDesktopShell: false,
      isVSCode: false,
    })).toBe('legacy-inline');
    expect(getGitViewRenderMode({
      screenWidth: 1280,
      isMobile: false,
      isDesktopShell: false,
      isVSCode: true,
    })).toBe('legacy-inline');
  });
});

describe('createGitContextCommitDetailsController', () => {
  test('routes graph file selection to the context commit diff with the exact comparison key', async () => {
    const openContextCommitDiffCalls: Array<{
      directory: string;
      target: {
        commitHash: string;
        parentHash: string | null;
        file: GitCommitChangedFile;
      };
    }> = [];
    const baseController = {
      selectFile() {},
    };
    const wrappedController = createGitContextCommitDetailsController(
      baseController as never,
      '/repo',
      (directory, target) => {
        openContextCommitDiffCalls.push({ directory, target });
      },
    );
    const selectedFile: GitCommitChangedFile = {
      path: 'src/history.ts',
      originalPath: 'src/history-before.ts',
      status: 'R',
      kind: 'file',
      originalObjectId: '1'.repeat(40),
      objectId: '2'.repeat(40),
      insertions: 7,
      deletions: 3,
      isBinary: false,
    };

    wrappedController?.selectFile?.({
      directory: '/repo',
      commitHash: 'a'.repeat(40),
      parentHash: 'c'.repeat(40),
    }, selectedFile);

    expect(openContextCommitDiffCalls).toEqual([{
      directory: '/repo',
      target: {
        commitHash: 'a'.repeat(40),
        parentHash: 'c'.repeat(40),
        file: selectedFile,
      },
    }]);
  });
});
