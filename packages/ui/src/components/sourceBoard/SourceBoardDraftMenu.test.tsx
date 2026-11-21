import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  DraftChangeRequestInput,
  ReadyChangeRequestInput,
  RepositoryChangeRequestReference,
  RuntimeAPIs,
  SourceControlCapabilities,
  SourceControlReadContext,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

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
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const pull = (draft: boolean): RepositoryChangeRequestReference => ({
  kind: 'pull', provider: 'github', number: 12, title: 'Login flow', url: 'https://example.com/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
});

const capabilities = (overrides: Partial<SourceControlCapabilities> = {}): SourceControlCapabilities => ({
  identity: { provider: 'github', instance: 'github.com' },
  authentication: true,
  authenticationMethods: {
    device: { available: false }, pat: { available: true }, cli: { available: false },
  },
  multipleAccounts: true,
  projects: true, issues: true, changeRequests: true, draftChangeRequests: true, draftConversion: true,
  mergeChangeRequests: true, mergeMethods: ['merge'], ci: true, ...overrides,
});

/** A GitHub host that records the draft transitions sent, and answers the capability probe. */
const setUp = async (overrides: Partial<SourceControlCapabilities> = {}) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const ordered = [githubLikeDescriptor()];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const sent: Array<{ kind: 'ready' | 'draft'; input: ReadyChangeRequestInput | DraftChangeRequestInput }> = [];
  const base = createWebAPIs();
  const apis = (): RuntimeAPIs => ({
    ...base,
    sourceControl: {
      ...base.sourceControl,
      capabilities: async () => capabilities(overrides),
      changeRequestReady: async (input) => {
        sent.push({ kind: 'ready', input });
        return { status: 'succeeded', replayed: false, result: { ready: true }, actor: { provider: input.provider, instance: input.instance, providerAccountId: 'github.com#7' }, target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } } };
      },
      changeRequestDraft: async (input) => {
        sent.push({ kind: 'draft', input });
        return { status: 'succeeded', replayed: false, result: { draft: true }, actor: { provider: input.provider, instance: input.instance, providerAccountId: 'github.com#7' }, target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } } };
      },
    },
  });
  return { apis, sent };
};

const render = async (apis: RuntimeAPIs, node: React.ReactNode) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  await act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>{node}</RuntimeAPIContext.Provider></I18nProvider>);
  });
};

const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');

const openMenu = async (reference: RepositoryChangeRequestReference, overrides: Partial<SourceControlCapabilities> = {}) => {
  const { SourceBoardStateMenuItems } = await import('./SourceBoardActions');
  const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('@/components/ui/dropdown-menu');
  const item = { source: 'repository' as const, reference };
  const settle = await setUp(overrides);
  await render(settle.apis(), (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild><button type="button">State</button></DropdownMenuTrigger>
      <DropdownMenuContent><SourceBoardStateMenuItems item={item} context={context} onChanged={() => undefined} /></DropdownMenuContent>
    </DropdownMenu>
  ));
  return settle;
};

const clickItem = async (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label);
  if (!element) throw new Error(`Expected ${label}`);
  await act(async () => { element.click(); });
};

describe('the state menu of a change request', () => {
  test('offers ready for review on a draft, and sends it', async () => {
    const { sent } = await openMenu(pull(true));
    expect(menuItems()).toContain('Ready for review');
    expect(menuItems()).not.toContain('Convert to draft');
    await clickItem('Ready for review');
    expect(sent.map((entry) => entry.kind)).toEqual(['ready']);
    expect(sent[0]?.input.target).toMatchObject({ number: 12 });
  });

  test('offers convert to draft on an open change request, and sends it', async () => {
    const { sent } = await openMenu(pull(false));
    expect(menuItems()).toContain('Convert to draft');
    expect(menuItems()).not.toContain('Ready for review');
    await clickItem('Convert to draft');
    expect(sent.map((entry) => entry.kind)).toEqual(['draft']);
  });

  test('offers neither when the host declares neither transition', async () => {
    const { sent } = await openMenu(pull(false), { draftConversion: false, draftChangeRequests: false });
    expect(menuItems()).not.toContain('Convert to draft');
    expect(sent).toHaveLength(0);
  });
});
