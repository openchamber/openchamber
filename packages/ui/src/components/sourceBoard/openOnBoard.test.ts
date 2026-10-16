import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { GitHubReferenceKind, ProjectEntry } from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

// What a click reaches, read at click time through module singletons.
const externalUrls: string[] = [];
const panelOpens: { directory: string; url: string }[] = [];
const boardFocus: { projectId: string; kind: GitHubReferenceKind; query: string }[] = [];
let desktopShell = false;
let vscodeRuntime = false;
let panelSetting = false;
let projects: ProjectEntry[] = [];

mock.module('@/lib/desktop', () => ({
  isDesktopShell: () => desktopShell,
  isVSCodeRuntime: () => vscodeRuntime,
}));
mock.module('@/lib/url', () => ({
  openExternalUrl: (url: string) => {
    externalUrls.push(url);
    return Promise.resolve();
  },
}));
mock.module('@/stores/useLinearAuthStore', () => ({
  useLinearAuthStore: { getState: () => ({ status: { connected: true } }) },
}));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: { getState: () => ({ projects }) },
}));
mock.module('@/stores/useSourceBoardStore', () => ({
  useSourceBoardStore: {
    getState: () => ({
      focusLinearIssue: () => undefined,
      focusRepositoryItem: (projectId: string, kind: GitHubReferenceKind, query: string) => {
        boardFocus.push({ projectId, kind, query });
      },
    }),
  },
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      openLinksInBrowserPanel: panelSetting,
      openContextPreview: (directory: string, url: string) => {
        panelOpens.push({ directory, url });
      },
      setSourceBoardOpen: () => undefined,
    }),
  },
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ availableWorktreesByProject: new Map() }) },
}));

import { boardTargetOfUrl, isSameRepositoryItemLink } from './openOnBoard';

describe('boardTargetOfUrl', () => {
  test('names the board tab a link belongs on', () => {
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber/pull/4500')).toEqual({ source: 'repository', kind: 'pull' });
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber/issues/4483')).toEqual({ source: 'repository', kind: 'issue' });
    expect(boardTargetOfUrl('https://gitlab.com/group/sub/app/-/merge_requests/7')).toEqual({ source: 'repository', kind: 'pull' });
    expect(boardTargetOfUrl('https://gitlab.com/group/sub/app/-/issues/3')).toEqual({ source: 'repository', kind: 'issue' });
    expect(boardTargetOfUrl('https://linear.app/openchamber/issue/ope-282/some-title')).toEqual({ source: 'linear', identifier: 'OPE-282' });
  });

  test('leaves anything else to the browser', () => {
    expect(boardTargetOfUrl('#12')).toBeNull();
    expect(boardTargetOfUrl('https://example.com/tickets/12')).toBeNull();
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber')).toBeNull();
  });
});

describe('isSameRepositoryItemLink', () => {
  test('matches the item a link names, whatever page of it the link opens', () => {
    const pull = 'https://github.com/BendingSpoons/athena/pull/2553';
    expect(isSameRepositoryItemLink(pull, 'https://github.com/bendingspoons/athena/pull/2553/files')).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/issues/2553')).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/pull/2566')).toBe(false);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/other/athena/pull/2553')).toBe(false);
  });

  test('tells GitLab issues and merge requests apart', () => {
    const request = 'https://gitlab.com/group/app/-/merge_requests/7';
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/merge_requests/7/diffs')).toBe(true);
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/issues/7')).toBe(false);
    expect(isSameRepositoryItemLink('#7', '#7')).toBe(false);
  });
});

describe('useOpenOnBoard', () => {
  const PULL_URL = 'https://github.com/openchamber/openchamber/pull/4500';
  const PROJECT: ProjectEntry = { id: 'proj-1', path: '/repo' };
  const WORKTREE_DIRECTORY = '/repo/worktrees/feature';

  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    externalUrls.length = 0;
    panelOpens.length = 0;
    boardFocus.length = 0;
    desktopShell = false;
    vscodeRuntime = false;
    panelSetting = false;
    projects = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const renderOpenOnBoard = async (): Promise<((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => void)> => {
    const { useOpenOnBoard } = await import('./openOnBoard');
    let hook: ReturnType<typeof useOpenOnBoard> | undefined;
    const Probe = () => {
      hook = useOpenOnBoard();
      return null;
    };
    await act(async () => root.render(React.createElement(Probe)));
    if (!hook) throw new Error('The hook did not render');
    return hook;
  };

  test('a plain click shows the link on the board of the directory\'s project', async () => {
    projects = [PROJECT];
    const openOnBoard = await renderOpenOnBoard();
    // The worktree map is empty here: the project root resolves by path prefix alone.
    openOnBoard(PULL_URL, WORKTREE_DIRECTORY);
    expect(boardFocus).toEqual([{ projectId: 'proj-1', kind: 'pull', query: PULL_URL }]);
    expect(panelOpens).toEqual([]);
    expect(externalUrls).toEqual([]);
  });

  test('an unresolved project opens the built-in browser panel of the directory when the panel setting is on', async () => {
    panelSetting = true;
    desktopShell = true;
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard(PULL_URL, '/somewhere/unopened');
    expect(panelOpens).toEqual([{ directory: '/somewhere/unopened', url: PULL_URL }]);
    expect(externalUrls).toEqual([]);
  });

  test('an unresolved project with the panel setting off falls back to the system browser', async () => {
    desktopShell = true;
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard(PULL_URL, '/somewhere/unopened');
    expect(externalUrls).toEqual([PULL_URL]);
    expect(panelOpens).toEqual([]);
  });

  test('a modified click opens the link itself', async () => {
    projects = [PROJECT];
    panelSetting = true;
    desktopShell = true;
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard(PULL_URL, PROJECT.path, { metaKey: true, ctrlKey: false });
    expect(externalUrls).toEqual([PULL_URL]);
    expect(boardFocus).toEqual([]);
    expect(panelOpens).toEqual([]);
  });

  test('the web runtime and a missing directory keep the system browser as the last resort', async () => {
    panelSetting = true;
    desktopShell = false;
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard(PULL_URL, '/somewhere/unopened');
    desktopShell = true;
    openOnBoard(PULL_URL, null);
    expect(externalUrls).toEqual([PULL_URL, PULL_URL]);
    expect(panelOpens).toEqual([]);
  });

  test('a link the board cannot show opens in the system browser, not the panel', async () => {
    panelSetting = true;
    desktopShell = true;
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard('https://example.com/page', '/somewhere');
    expect(externalUrls).toEqual(['https://example.com/page']);
    expect(panelOpens).toEqual([]);
  });

  test('VS Code keeps the system browser', async () => {
    vscodeRuntime = true;
    panelSetting = true;
    desktopShell = true;
    projects = [PROJECT];
    const openOnBoard = await renderOpenOnBoard();
    openOnBoard(PULL_URL, PROJECT.path);
    expect(externalUrls).toEqual([PULL_URL]);
    expect(boardFocus).toEqual([]);
  });
});
