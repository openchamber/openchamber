import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RepositoryChangeRequestReference, RuntimeAPIs, SourceControlReadContext } from '@/lib/api/types';
import type { CI, ChangeRequestContext } from '@/lib/source-control/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

// The dialog refreshes on an interval; the test fires every interval by hand.
let refreshes = new Map<number, () => void>();
let nextInterval = 1;
Object.assign(browser, {
  setInterval: (callback: () => void) => {
    const id = nextInterval++;
    refreshes.set(id, callback);
    return id;
  },
  clearInterval: (id: number) => { refreshes.delete(id); },
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  refreshes = new Map();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const identity = { provider: 'github', instance: 'github.com' };
const context: SourceControlReadContext = {
  ...identity, directory: '/work/app', repositoryId: 'repo-1', accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const pull = (number: number): RepositoryChangeRequestReference => ({
  kind: 'pull', provider: 'github', number, title: 'Login flow', url: `https://github.com/acme/app/pull/${number}`,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
});
const build = { ...identity, id: '12', name: 'build', status: 'completed', conclusion: 'success' };
const hardware = (state: 'pending' | 'success') => ({
  ...identity, id: 'status:ci/hardware', name: 'ci/hardware',
  ...(state === 'pending' ? { status: 'in_progress' } : { status: 'completed', conclusion: 'success' }),
});

// What GitHub answers now; a test moves it on between refreshes.
let answer: CI | null = null;

const render = async (number: number) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SourceBoardChecksDialog } = await import('./SourceBoardChecksDialog');
  const ordered = [githubLikeDescriptor()];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const base = createWebAPIs();
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      changeRequestContext: async (): Promise<ChangeRequestContext> => {
        return { identity, project: null, changeRequest: null, issueComments: [], reviewComments: [], files: [], ci: answer };
      },
    },
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <SourceBoardChecksDialog pull={pull(number)} context={context} open onOpenChange={() => undefined} />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const dialogText = () => document.body.textContent ?? '';
const refresh = async () => {
  await act(async () => { for (const callback of refreshes.values()) callback(); });
};

describe('the checks dialog with commit statuses', () => {
  test('a passed run beside a pending status shows both rows and turns passed without reopening', async () => {
    answer = { summary: { state: 'pending', total: 2, success: 1, failure: 0, pending: 1, inProgress: 1, queued: 0 }, runs: [build, hardware('pending')] };
    await render(41);
    expect(dialogText()).toContain('1 of 2 running');
    expect(dialogText()).toContain('build');
    expect(dialogText()).toContain('ci/hardware');
    expect(refreshes.size).toBeGreaterThan(0);

    answer = { summary: { state: 'success', total: 2, success: 2, failure: 0, pending: 0, inProgress: 0, queued: 0 }, runs: [build, hardware('success')] };
    await refresh();
    expect(dialogText()).toContain('All passed');
    expect(dialogText()).toContain('ci/hardware');
    // Nothing is pending any more, so the dialog stops refreshing.
    expect(refreshes.size).toBe(0);
  });

  test('a refresh that could not read the statuses keeps refreshing until the pending one passes', async () => {
    answer = { summary: { state: 'pending', total: 2, success: 1, failure: 0, pending: 1, inProgress: 1, queued: 0 }, runs: [build, hardware('pending')] };
    await render(43);
    expect(dialogText()).toContain('ci/hardware');

    // The statuses request failed: only the passed run loaded, and the summary is not final.
    answer = { summary: { state: 'unknown', total: 1, success: 1, failure: 0, pending: 0, inProgress: 0, queued: 0 }, runs: [build] };
    await refresh();
    expect(dialogText()).toContain('Couldn\'t read every check');
    expect(refreshes.size).toBeGreaterThan(0);

    answer = { summary: { state: 'success', total: 2, success: 2, failure: 0, pending: 0, inProgress: 0, queued: 0 }, runs: [build, hardware('success')] };
    await refresh();
    expect(dialogText()).toContain('All passed');
    expect(dialogText()).toContain('ci/hardware');
    expect(dialogText()).not.toContain('Couldn\'t read every check');
    expect(refreshes.size).toBe(0);
  });

  test('a read that returned no checks result says so instead of spinning', async () => {
    answer = null;
    await render(44);
    expect(dialogText()).toContain('Couldn\'t read every check');
    expect(document.querySelector('[data-spinner]')).toBeNull();
    expect(dialogText()).not.toContain('No checks ran');
    expect(refreshes.size).toBeGreaterThan(0);
  });

  test('a commit with commit statuses only lists them instead of saying no checks ran', async () => {
    answer = { summary: { state: 'success', total: 1, success: 1, failure: 0, pending: 0, inProgress: 0, queued: 0 }, runs: [hardware('success')] };
    await render(42);
    expect(dialogText()).toContain('ci/hardware');
    expect(dialogText()).not.toContain('No checks ran');
  });
});
