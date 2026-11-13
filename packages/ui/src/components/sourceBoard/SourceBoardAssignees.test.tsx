import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';

import type {
  RepositoryIssueReference,
  RepositoryReferenceDetail,
  RepositoryReferenceReviewer,
  RuntimeAPIs,
  SetAssigneesInput,
  SourceControlReadContext,
} from '@/lib/api/types';

// The row's refusals are read from what it tells the user, not from a toast
// host; the picker and the buttons keep their own modules.
const errors: Array<{ message: string; description?: string }> = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string, data?: { description?: string }) => { errors.push({ message, description: data?.description }); },
    success: () => undefined,
    info: () => undefined,
  },
}));

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLImageElement: browser.HTMLImageElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ENVIRONMENT: true, IS_REACT_ACT_ENVIRONMENT: true,
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
  errors.length = 0;
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};

const issue: RepositoryIssueReference = {
  kind: 'issue', provider: 'github', number: 7, title: 'Tidy the header', url: 'https://github.com/acme/app/issues/7',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open',
};

const ada: RepositoryReferenceReviewer = { id: 'ada-id', login: 'ada' };
const grace: RepositoryReferenceReviewer = { id: 'grace-id', login: 'grace' };
const linus: RepositoryReferenceReviewer = { id: 'linus-id', login: 'linus' };

const detailWith = (assignees?: RepositoryReferenceReviewer[]): RepositoryReferenceDetail => {
  const detail: RepositoryReferenceDetail = { number: 7, comments: [], commentTotal: 0, pull: null };
  if (assignees) detail.assignees = assignees;
  return detail;
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  // Static rendering reads the registry's first state, not its current one.
  Object.assign(useSourceControlProviderRegistry.getInitialState(), { ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  assignees?: RepositoryReferenceReviewer[];
  candidates?: RepositoryReferenceReviewer[] | Error;
  failSave?: boolean;
};

/** Renders the row and records what it sends and asks to refresh. */
const show = async (options: ShowOptions = {}) => {
  const [{ SourceBoardAssignees }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./SourceBoardMetaEditors'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const calls: SetAssigneesInput[] = [];
  let changed = 0;
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      referenceReviewers: async () => {
        if (options.candidates instanceof Error) throw options.candidates;
        return options.candidates ?? [ada, grace, linus];
      },
      issueSetAssignees: async (payload) => {
        calls.push(payload);
        if (options.failSave) throw new Error('You may not assign people here');
        return {
          status: 'succeeded', replayed: false, result: {},
          actor: { provider: payload.provider, instance: payload.instance, providerAccountId: `${payload.instance}#7` },
          target: {
            repositoryId: payload.repositoryId, bindingRevision: payload.bindingRevision, primaryRemote: payload.primaryRemote,
            project: { id: '1', owner: 'acme', name: 'app' },
          },
        };
      },
    },
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <SourceBoardAssignees
            issue={issue}
            detail={{ status: 'ready', value: detailWith(options.assignees) }}
            context={context}
            onChanged={() => { changed += 1; }}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  return { calls, changed: () => changed };
};

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  // The picker commits when it closes; the save settles on the next microtasks.
  await act(async () => { await Promise.resolve(); });
};

const pencil = (label = 'Edit assignees') => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const choice = (login: string) => [...(dialog()?.querySelectorAll<HTMLElement>('[data-slot="command-item"]') ?? [])]
  .find((item) => item.textContent?.includes(login));

describe('an issue\'s assignees row', () => {
  test('shows the people the detail names, with a pencil once the project lists who can be picked', async () => {
    await show({ assignees: [ada, grace] });
    expect(host.textContent).toContain('ada');
    expect(host.textContent).toContain('grace');
    expect(pencil()).not.toBeNull();
  });

  test('reads as unassigned with no one on the issue', async () => {
    await show({ assignees: [] });
    expect(host.textContent).toContain('—');
    expect(host.textContent).toContain('Unassigned');
    expect(pencil()).not.toBeNull();
  });

  test('stays read only when the project will not name who can be assigned', async () => {
    const refused = Object.assign(new Error('Not supported by this host'), { code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED' });
    await show({ assignees: [ada], candidates: refused });
    expect(host.textContent).toContain('ada');
    expect(pencil()).toBeNull();
  });

  test('keeps the pencil when the read failed, and says so when the picker opens', async () => {
    await show({ assignees: [ada], candidates: new Error('Rate limited, try again') });
    expect(host.textContent).toContain('ada');
    expect(pencil()).not.toBeNull();
    await click(pencil());
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('Rate limited, try again');
  });

  test('opens the picker with the current people checked', async () => {
    await show({ assignees: [ada] });
    await click(pencil());
    expect(dialog()).not.toBeNull();
    expect(choice('ada')?.getAttribute('aria-current')).toBe('true');
    expect(choice('grace')?.getAttribute('aria-current')).toBeNull();
  });

  test('sends the whole set of ids once the picker closes, then refreshes', async () => {
    const { calls, changed } = await show({ assignees: [ada] });
    await click(pencil());
    await click(choice('grace'));
    await click(pencil());
    expect(calls).toHaveLength(1);
    expect(calls[0].assignees).toEqual(['ada-id', 'grace-id']);
    expect(calls[0].target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7 });
    expect(changed()).toBe(1);
    expect(errors).toEqual([]);
  });

  test('keeps the old set and shows the host message when the save is refused', async () => {
    const { calls, changed } = await show({ assignees: [ada], failSave: true });
    await click(pencil());
    await click(choice('grace'));
    await click(pencil());
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([{ message: 'Could not change the assignees on #7', description: 'You may not assign people here' }]);
    expect(host.textContent).toContain('ada');
    expect(host.textContent).not.toContain('grace');
    expect(changed()).toBe(1);
  });
});

describe('a preview without an assignees control', () => {
  const renderPreview = async (detail: RepositoryReferenceDetail) => {
    const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
      import('@/components/references/ReferencePreview'),
      import('@/lib/i18n'),
      import('@/contexts/runtimeAPIContext'),
      import('../../../../web/src/api/index'),
    ]);
    await setProvider();
    const container = browser.document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <RuntimeAPIContext.Provider value={createWebAPIs()}>
        <I18nProvider>
          <ReferencePreview
            item={{ source: 'repository', reference: issue }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: detail }}
            purpose="attach"
            pinned
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
          />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
    return container;
  };

  test('shows the detail\'s assignees as plain people', async () => {
    const container = await renderPreview(detailWith([ada, grace]));
    expect(container.textContent).toContain('Assignees');
    expect(container.textContent).toContain('ada');
    expect(container.textContent).toContain('grace');
    expect(container.querySelector('button[aria-label="Edit assignees"]')).toBeNull();
  });

  test('shows no row when the detail carries none', async () => {
    const container = await renderPreview(detailWith());
    expect(container.textContent).not.toContain('Assignees');
    expect(container.textContent).not.toContain('Unassigned');
  });
});
