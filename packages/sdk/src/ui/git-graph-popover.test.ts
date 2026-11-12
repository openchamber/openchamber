import { describe, expect, test } from 'bun:test';
// The SDK package does not own the DOM test dependency; reuse the workspace fixture.
import { Window } from '../../../ui/node_modules/happy-dom';

import type { HostReadyContext } from '../contract.ts';
import type { HostClient } from '../host.ts';
import { startCommitPopover } from '../../examples/git-graph-status/status/commit-popover.ts';

const fixture = () => {
  const window = new Window();
  const previous = {
    document: globalThis.document, window: globalThis.window, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
    HTMLStyleElement: globalThis.HTMLStyleElement, Node: globalThis.Node, ResizeObserver: globalThis.ResizeObserver,
  };
  Object.assign(globalThis, {
    document: window.document, window, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLStyleElement: window.HTMLStyleElement, Node: window.Node, ResizeObserver: window.ResizeObserver,
  });
  const root = window.document.createElement('div');
  window.document.body.append(root);
  const copied: string[] = [];
  const openedUrls: string[] = [];
  const openedCommits: string[] = [];
  // SAFETY: the popup bootstrap uses only these HostClient members in this fixture.
  const host = {
    serviceRequest: async () => ({ status: 200, body: JSON.stringify({
      hash: '0123456789abcdef', parents: [], author: 'Ada Lovelace', email: 'ada@example.test', when: '2 hours ago',
      date: '2026-10-03T14:22:00.000Z', subject: 'Add anchored popovers', body: '', files: 3, insertions: 42, deletions: 7,
    }) }),
    onDirectory: () => () => undefined,
    setHeight: async () => undefined,
    onPopoverClosed: () => () => undefined,
    writeClipboard: async (text: string) => { copied.push(text); },
    openUrl: async (url: string) => { openedUrls.push(url); },
    openCommit: async (sha: string) => { openedCommits.push(sha); },
  } as HostClient;
  // SAFETY: the popup bootstrap reads only the declared ready fields below.
  const context = {
    surface: 'popover', directory: '/repo', locale: 'en', popover: {
      id: 'popover-1', data: {
        sha: '0123456789abcdef', refs: [{ name: 'main', kind: 'local', head: true }],
        github: 'https://github.com/openchamber/openchamber',
      },
    },
  } as HostReadyContext;
  return { root, host, context, copied, openedUrls, openedCommits, restore: () => Object.assign(globalThis, previous) };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Bun.sleep(0);
};

describe('Git Graph popover', () => {
  test('renders fetched commit data and routes its controls through host actions', async () => {
    const f = fixture();
    try {
      startCommitPopover(f.root, f.host, f.context);
      await settle();

      expect(f.root.textContent ?? '').toContain('Add anchored popovers');
      expect(f.root.querySelector('[data-commit-popover-refs]')?.textContent).toBe('main');
      const buttons = [...f.root.querySelectorAll('button')];
      buttons.find((button) => button.textContent === 'Copy hash')?.click();
      buttons.find((button) => button.textContent === 'Open diff')?.click();
      buttons.find((button) => button.textContent === 'Open on GitHub')?.click();
      await settle();

      expect(f.copied).toEqual(['0123456789abcdef']);
      expect(f.openedCommits).toEqual(['0123456789abcdef']);
      expect(f.openedUrls).toEqual(['https://github.com/openchamber/openchamber/commit/0123456789abcdef']);
    } finally {
      f.restore();
    }
  });
});
