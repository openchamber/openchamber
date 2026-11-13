import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type { RepositoryIssueReference, RepositoryReferenceDetail, RepositoryReferenceLink } from '@/lib/api/types';

mock.module('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => createElement('div', null, content),
}));

// What a chip's click opens, in place of the chat's own link handling.
const opened: string[] = [];
mock.module('@/components/chat/useOpenChatLink', () => ({
  useOpenChatLink: () => (url: string) => { opened.push(url); },
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
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');

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
  opened.length = 0;
});

const issue: RepositoryIssueReference = {
  kind: 'issue', provider: 'github', number: 7, title: 'Tidy the header', url: 'https://github.com/acme/app/issues/7',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null,
  author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open',
};

const mention = (overrides: Partial<RepositoryReferenceLink> = {}): RepositoryReferenceLink => ({
  kind: 'issue', number: 8, title: 'The header story', url: 'https://github.com/acme/app/issues/8',
  repo: 'acme/app', createdAt: '2026-10-01T12:00:00Z', author: { login: 'riri' }, ...overrides,
});

const detailWith = (overrides: Partial<RepositoryReferenceDetail> = {}): RepositoryReferenceDetail => ({
  number: 7, comments: [], commentTotal: 0, pull: null, ...overrides,
});

const setProvider = async (overrides: { changeRequestPrefix?: string } = {}) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const base = githubLikeDescriptor();
  const descriptor = overrides.changeRequestPrefix
    ? { ...base, terminology: { ...base.terminology, changeRequestPrefix: overrides.changeRequestPrefix } }
    : base;
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

const show = async (detail: RepositoryReferenceDetail, overrides: { changeRequestPrefix?: string } = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider(overrides);
  const apis = createWebAPIs();
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePreview
            item={{ source: 'repository', reference: issue }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: detail }}
            purpose="attach"
            pinned={false}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
            onRefresh={async () => undefined}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const rows = () => [...host.querySelectorAll<HTMLElement>('section div.group.relative')];
const chips = () => [...host.querySelectorAll<HTMLAnchorElement>('section a[aria-label^="Open "]')];
const rowText = (row: HTMLElement) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('items that mentioned the previewed one', () => {
  test('each mention is a row with its author and chip, ordered by time among the comments', async () => {
    await show(detailWith({
      comments: [{ author: { login: 'sam' }, body: 'A note', createdAt: '2026-10-02T12:00:00Z', url: 'https://github.com/acme/app/issues/7#c1', path: null, line: null, review: null }],
      commentTotal: 1,
      references: [
        mention(),
        mention({ number: 9, title: 'Elsewhere', url: 'https://github.com/acme/other/issues/9', repo: 'acme/other', createdAt: '2026-10-03T12:00:00Z', author: { login: 'koda' } }),
      ],
    }));

    expect(rows().map((row) => row.textContent?.includes('mentioned this in') ? 'mention' : 'comment')).toEqual(['mention', 'comment', 'mention']);
    expect(rowText(rows()[0]!)).toContain('riri');
    expect(rowText(rows()[1]!)).toContain('sam');
    expect(rowText(rows()[2]!)).toContain('koda');
  });

  test('a mention in the item’s own repository is #N, another repository names its owner', async () => {
    await show(detailWith({
      references: [mention(), mention({ number: 9, url: 'https://github.com/acme/other/issues/9', repo: 'acme/other' })],
    }));

    expect(chips().map((chip) => chip.textContent)).toEqual(['#8', 'acme/other#9']);
    expect(chips().map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/acme/app/issues/8',
      'https://github.com/acme/other/issues/9',
    ]);
    expect(chips().map((chip) => chip.getAttribute('aria-label'))).toEqual(['Open #8', 'Open acme/other#9']);
  });

  test('a mention the host gave no title or repository stays #N, with no tooltip text', async () => {
    await show(detailWith({
      references: [mention({ number: 5, title: undefined, repo: undefined, url: 'https://gitlab.com/group/app/-/issues/5' })],
    }));

    expect(chips().map((chip) => chip.textContent)).toEqual(['#5']);
    expect(host.textContent).not.toContain('The header story');
  });

  test('a merge request takes the host’s own mark, so !12 never reads as an issue', async () => {
    await show(detailWith({
      references: [mention({ kind: 'pull', number: 12, repo: 'acme/app', url: 'https://github.com/acme/app/pull/12' })],
    }), { changeRequestPrefix: '!' });

    expect(chips().map((chip) => chip.textContent)).toEqual(['!12']);
    expect(chips()[0]?.getAttribute('aria-label')).toBe('Open !12');
  });

  test('an item with no mentions shows no linked-issues section', async () => {
    await show(detailWith());
    expect([...host.querySelectorAll('h4')].some((heading) => heading.textContent === 'Linked issues')).toBe(false);
    expect(host.textContent).not.toContain('Linked issues');
    expect(chips()).toEqual([]);
  });

  test('clicking a chip opens the mention the way the item’s other links do', async () => {
    await show(detailWith({ references: [mention()] }));

    await act(async () => { chips()[0]?.click(); });
    expect(opened).toEqual(['https://github.com/acme/app/issues/8']);
  });
});
