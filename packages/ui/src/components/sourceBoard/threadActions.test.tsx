import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type { RepositoryChangeRequestReference, SourceControlReadContext } from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');
const { useThreadActions } = await import('./threadActions');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const context: SourceControlReadContext = {
  provider: 'acme', instance: 'https://forge.example.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'acme#7', bindingRevision: 1, primaryRemote: 'origin',
};

const reference: RepositoryChangeRequestReference = {
  kind: 'pull', provider: 'acme', number: 12, title: 'Login flow', url: 'https://forge.example.com/org/app/pulls/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'org', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
};

const serveCapabilities = async (capabilities?: SourceControlProviderDescriptor['capabilities']) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { acmeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = acmeDescriptor({ capabilities });
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

const ThreadControls: React.FC = () => {
  const actions = useThreadActions(reference, context, () => undefined);
  return (
    <>
      {actions?.reply ? <button type="button">Reply</button> : null}
      {actions?.setResolved ? <button type="button">Resolve</button> : null}
    </>
  );
};

const render = async () => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={createWebAPIs()}>
          <ThreadControls />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');

describe('answer and resolve controls follow the host capability', () => {
  test('a host that answers no threads shows neither control', async () => {
    await serveCapabilities({ reviewThreads: { start: false, reply: false, resolve: false } });
    await render();
    expect(buttons()).toEqual([]);
  });

  test('a host that only takes replies shows the reply control alone', async () => {
    await serveCapabilities({ reviewThreads: { start: false, reply: true, resolve: false } });
    await render();
    expect(buttons()).toEqual(['Reply']);
  });

  test('a host that answers and resolves threads shows both controls', async () => {
    await serveCapabilities({ reviewThreads: { start: true, reply: true, resolve: true } });
    await render();
    expect(buttons()).toEqual(['Reply', 'Resolve']);
  });

  test('a host that says nothing about threads keeps both controls', async () => {
    await serveCapabilities();
    await render();
    expect(buttons()).toEqual(['Reply', 'Resolve']);
  });
});
