import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { ExternalToast } from 'sonner';

import type {
  RebaseChangeRequestInput,
  RepositoryChangeRequestReference,
  RuntimeAPIs,
  SourceControlCapabilities,
  SourceControlEmptyMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadContext,
  UpdateChangeRequestBranchInput,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

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

// What the menu tells the user, read here instead of from a toast host.
const succeeded: string[] = [];
const refused: Array<{ message: string; description?: unknown }> = [];
const { toast } = await import('@/components/ui');
toast.success = (message: ReactNode) => {
  succeeded.push(String(message));
  return 1;
};
toast.error = (message: ReactNode, data?: ExternalToast) => {
  refused.push({ message: String(message), description: data?.description });
  return 1;
};

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
  succeeded.length = 0;
  refused.length = 0;
});

const contextFor = (provider: string): SourceControlReadContext => ({
  provider, instance: provider === 'github' ? 'github.com' : `https://${provider}.example.com`,
  directory: '/work/app', repositoryId: 'repo-1', accountId: `${provider}#7`, bindingRevision: 1, primaryRemote: 'origin',
});

const pull = (options: { state?: 'open' | 'closed' | 'merged'; draft?: boolean; provider?: string } = {}): RepositoryChangeRequestReference => ({
  kind: 'pull', provider: options.provider ?? 'github', number: 12, title: 'Login flow', url: 'https://example.com/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: options.state ?? 'open', draft: options.draft ?? false,
  head: 'feature', base: 'main', headSha: 'a'.repeat(40), headRepo: null,
});

const capabilities = (): SourceControlCapabilities => ({
  identity: { provider: 'github', instance: 'github.com' },
  authentication: true,
  authenticationMethods: {
    device: { available: false }, pat: { available: true }, cli: { available: false },
  },
  multipleAccounts: true,
  projects: true, issues: true, changeRequests: true, draftChangeRequests: true, draftConversion: true,
  mergeChangeRequests: true, mergeMethods: ['merge'], ci: true,
});

/** A host that records the branch writes it is asked for, and answers the capability probe. */
const setUp = async (descriptor: SourceControlProviderDescriptor, options: { fail?: 'update' | 'rebase' } = {}) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const ordered = [descriptor];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const updates: UpdateChangeRequestBranchInput[] = [];
  const rebases: RebaseChangeRequestInput[] = [];
  const base = createWebAPIs();
  const receipt = (input: UpdateChangeRequestBranchInput | RebaseChangeRequestInput): SourceControlMutationReceipt<SourceControlEmptyMutationResult> => ({
    status: 'succeeded', replayed: false, result: {},
    actor: { provider: input.provider, instance: input.instance, providerAccountId: `${input.provider}#7` },
    target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } },
  });
  const apis = (): RuntimeAPIs => ({
    ...base,
    sourceControl: {
      ...base.sourceControl,
      capabilities: async () => capabilities(),
      changeRequestUpdateBranch: async (input) => {
        if (options.fail === 'update') throw new Error('The branch moved');
        updates.push(input);
        return receipt(input);
      },
      changeRequestRebase: async (input) => {
        if (options.fail === 'rebase') throw new Error('A merge request is already open');
        rebases.push(input);
        return receipt(input);
      },
    },
  });
  return { apis, updates, rebases };
};

const render = async (apis: RuntimeAPIs, node: React.ReactNode) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  await act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>{node}</RuntimeAPIContext.Provider></I18nProvider>);
  });
};

const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');

const openMenu = async (
  reference: RepositoryChangeRequestReference,
  descriptor: SourceControlProviderDescriptor,
  options: { fail?: 'update' | 'rebase' } = {},
) => {
  const { SourceBoardStateMenuItems } = await import('./SourceBoardActions');
  const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('@/components/ui/dropdown-menu');
  const item = { source: 'repository' as const, reference };
  const settle = await setUp(descriptor, options);
  let changes = 0;
  await render(settle.apis(), (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild><button type="button">State</button></DropdownMenuTrigger>
      <DropdownMenuContent><SourceBoardStateMenuItems item={item} context={contextFor(reference.provider)} onChanged={() => { changes += 1; }} /></DropdownMenuContent>
    </DropdownMenu>
  ));
  return { ...settle, changes: () => changes };
};

const clickItem = async (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label);
  if (!element) throw new Error(`Expected ${label}`);
  await act(async () => { element.click(); });
};

describe('the state menu of an open change request', () => {
  test('asks to update the branch with the head it saw, then reads the item again', async () => {
    const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
    const { updates, rebases, changes } = await openMenu(pull(), githubLikeDescriptor());

    expect(menuItems()).toContain('Update branch');
    expect(menuItems()).not.toContain('Rebase onto base');
    // It comes after the close item, which keeps its place.
    expect(menuItems().indexOf('Update branch')).toBeGreaterThan(menuItems().indexOf('Close pull request'));

    await clickItem('Update branch');

    expect(updates).toHaveLength(1);
    expect(updates[0]?.expectedHeadSha).toBe('a'.repeat(40));
    expect(updates[0]?.target).toMatchObject({ number: 12 });
    expect(rebases).toHaveLength(0);
    expect(changes()).toBe(1);
    expect(succeeded).toEqual(['Started updating the branch of #12']);
    expect(refused).toHaveLength(0);
  });

  test('asks to rebase with nothing but the target, then reads the item again', async () => {
    const { gitlabLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
    const gitlab = gitlabLikeDescriptor();
    const descriptor: SourceControlProviderDescriptor = {
      ...gitlab,
      features: { ...gitlab.features, updateBranch: false, rebase: true },
    };
    const { updates, rebases, changes } = await openMenu(pull({ provider: 'gitlab' }), descriptor);

    expect(menuItems()).toContain('Rebase onto base');
    expect(menuItems()).not.toContain('Update branch');

    await clickItem('Rebase onto base');

    expect(rebases).toHaveLength(1);
    expect(Object.keys(rebases[0]!).sort()).toEqual([
      'accountId', 'bindingRevision', 'directory', 'idempotencyKey', 'instance', 'primaryRemote', 'provider', 'repositoryId', 'target',
    ]);
    expect(updates).toHaveLength(0);
    expect(changes()).toBe(1);
    expect(succeeded).toEqual(['Started rebasing !12 onto its base']);
  });

  test('offers neither where the host declares neither', async () => {
    const { unknownProviderDescriptor } = await import('@/lib/source-control/providers/descriptor');
    const { updates, rebases, changes } = await openMenu(pull({ provider: 'acme' }), unknownProviderDescriptor('acme'));

    expect(menuItems()).not.toContain('Update branch');
    expect(menuItems()).not.toContain('Rebase onto base');
    expect(updates).toHaveLength(0);
    expect(rebases).toHaveLength(0);
    expect(changes()).toBe(0);
  });

  test('offers neither on a draft, a closed or a merged change request', async () => {
    const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
    for (const reference of [pull({ draft: true }), pull({ state: 'closed' }), pull({ state: 'merged' })]) {
      const { updates, changes } = await openMenu(reference, githubLikeDescriptor());
      expect(menuItems()).not.toContain('Update branch');
      expect(updates).toHaveLength(0);
      expect(changes()).toBe(0);
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  test('a refusal says why and still reads the item again, so the menu closes on fresh state', async () => {
    const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
    const { updates, changes } = await openMenu(pull(), githubLikeDescriptor(), { fail: 'update' });

    await clickItem('Update branch');

    expect(updates).toHaveLength(0);
    expect(refused).toEqual([{ message: 'Could not update the branch of #12', description: 'The branch moved' }]);
    expect(succeeded).toHaveLength(0);
    expect(changes()).toBe(1);
  });
});
