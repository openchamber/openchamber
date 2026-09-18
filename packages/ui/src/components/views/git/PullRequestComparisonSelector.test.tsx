import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';

const checkPullRequestSelection = async (mobile: boolean, tablet = false) => {
  const dom = new Window({ url: 'http://localhost' });
  if (mobile && !tablet) dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let failNextPage = true;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    if (url.pathname === '/api/github/pr/status') return Response.json({ connected: true, repo: { owner: 'upstream', repo: 'project' },
      pr: { number: 42, title: 'Resolved PR', url: 'https://github.com/upstream/project/pull/42', state: 'open', draft: false, head: 'feature-0', base: 'main' } });
    if (url.pathname !== '/api/github/pulls/list') throw new Error(`Unexpected request ${url.pathname}`);
    requestCount += 1;
    if (url.searchParams.get('page') === '2' && failNextPage) return Response.json({ error: 'Next page failed' }, { status: 503 });
    if (url.searchParams.get('query') === 'missing') return Response.json({ connected: true, repo: { owner: 'upstream', repo: 'project' }, prs: [], hasMore: false });
    return Response.json({ connected: true, repo: { owner: 'upstream', repo: 'project' }, hasMore: url.searchParams.get('page') !== '2',
      prs: ['upstream', 'fork'].map((owner, index) => ({ number: 42, title: `${owner} PR`,
        url: `https://github.com/${owner}/project/pull/42`, state: 'open', draft: false, base: 'main', head: `feature-${index}`,
        sourceRepo: { owner, repo: 'project', source: owner } })) });
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { usePullRequestComparison } = await import('@/hooks/usePullRequestComparison');
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  usePullRequestSelectionStore.setState({ selections: new Map() });
  const { useGitHubAuthStore } = await import('@/stores/useGitHubAuthStore');
  useGitHubAuthStore.setState({ hasChecked: true, status: { connected: true } });
  const { PullRequestComparisonSelector } = await import('./PullRequestComparisonSelector');
  const apis = createWebAPIs();
  let directory = '/repo';
  let active = 'changes';
  let walkthroughMount = 0;
  let preferred: PullRequestSource | undefined;
  function Harness({ name }: { name: string }) {
    const comparison = usePullRequestComparison(directory, 'feature-0', active === name, name === 'walkthrough' ? preferred : undefined);
    return <section data-picker={name}><PullRequestComparisonSelector comparison={comparison} mobile={mobile} />
      <output>{comparison.selectedSource?.sourceRepo?.owner}</output></section>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => { root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
    <Harness name="changes" /><Harness key={walkthroughMount} name="walkthrough" />
  </RuntimeAPIContext.Provider></I18nProvider>); });
  const trigger = (name: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[data-picker="${name}"] button`);
    if (!button) throw new Error('Missing PR picker');
    return button;
  };
  const press = async (key: string, ctrlKey = false) => {
    const input = document.querySelector('input');
    if (!input) throw new Error('Missing PR search');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true })); });
  };
  try {
    await render();
    expect(requestCount).toBe(1);
    expect(container.querySelector('[data-picker="changes"] output')?.textContent).toBe('upstream');
    await act(async () => trigger('changes').click());
    if (mobile && !tablet) expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    else expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    const loadMore = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Load more');
    if (!loadMore) throw new Error('Missing pagination');
    await act(async () => loadMore.click());
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Next page failed');
    failNextPage = false;
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing page retry');
    await act(async () => retry.click());
    // A PR repeated across pages must not create a duplicate choice.
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    await press('ArrowDown');
    expect(document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value')).toBe('fork/project#42');
    await press('p', true);
    await press('n', true);
    await press('Enter');
    expect(container.querySelector('[data-picker="walkthrough"] output')?.textContent).toBe('fork');

    preferred = { kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } };
    active = 'walkthrough';
    await render();
    expect(container.querySelector('[data-picker="changes"] output')?.textContent).toBe('upstream');
    await act(async () => trigger('walkthrough').click());
    await press('n', true);
    await press('Enter');
    expect(container.querySelector('[data-picker="changes"] output')?.textContent).toBe('fork');
    walkthroughMount += 1;
    await render();
    expect(container.querySelector('[data-picker="walkthrough"] output')?.textContent).toBe('fork');
    active = 'changes';
    await render();
    active = 'walkthrough';
    await render();
    expect(container.querySelector('[data-picker="walkthrough"] output')?.textContent).toBe('fork');
    await act(async () => trigger('walkthrough').click());
    const searchInput = document.querySelector('input');
    if (!searchInput) throw new Error('Missing PR search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(searchInput, 'missing');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(0);
    expect(document.body.textContent).toContain('No pull requests found');
    const beforeHide = requestCount;
    active = '';
    await render();
    expect(requestCount).toBe(beforeHide);
    expect(document.querySelector('[cmdk-item]')).toBeNull();

    preferred = undefined;
    directory = '/other';
    await render();
    expect(container.querySelector('[data-picker="changes"] output')?.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('desktop PR selection shares handoffs, pages, searches, retries, and isolates directories', () => checkPullRequestSelection(false));
test('phone PR selection uses a sheet with shared selection and keyboard navigation', () => checkPullRequestSelection(true));
test('tablet PR selection stays in an anchored picker', () => checkPullRequestSelection(true, true));
