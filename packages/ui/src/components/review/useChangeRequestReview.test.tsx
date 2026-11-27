import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RuntimeAPIs, SourceControlReadContext } from '@/lib/api/types';
import type { ChangeRequestReviewStateResult } from '@/lib/source-control/types';
import type { ChangeRequestReview } from './useChangeRequestReview';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The hook's imports pull in app stores that load on import; their requests never answer.
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
const project = { owner: 'acme', name: 'app' };

const state: ChangeRequestReviewStateResult = {
  connected: true, viewerIsAuthor: false, headSha: 'b'.repeat(40), truncated: false, threads: [],
  draft: { id: 'R1', body: '', comments: [
    { id: 'c1', path: 'a.ts', side: 'new', line: 3, startLine: null, body: 'Pending note', author: { login: 'mona' } },
  ] },
};

type SeenReview = { review: ChangeRequestReview | null };

/** Opens Changes on pull request 12 the way the board's link does, after the board saw `boardAccess`. */
const openChanges = async (boardAccess: boolean | undefined, changesContext: SourceControlReadContext = context) => {
  const [hooks, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }, registry, fixture] = await Promise.all([
    import('./useChangeRequestReview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
    import('@/lib/source-control/providers/registry'),
    import('@/lib/source-control/providers/descriptor.fixture'),
  ]);
  const base = fixture.githubLikeDescriptor();
  const descriptor = { ...base, features: { ...base.features, reviewDrafts: true } };
  registry.useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });

  const writes: string[] = [];
  const reads: Array<Promise<ChangeRequestReviewStateResult>> = [];
  const web = createWebAPIs();
  const write = (kind: string) => async () => {
    writes.push(kind);
    throw new Error('A denied account sent a draft write');
  };
  const apis: RuntimeAPIs = {
    ...web,
    sourceControl: {
      ...web.sourceControl,
      changeRequestReviewState: () => {
        const read = Promise.resolve(state);
        reads.push(read);
        return read;
      },
      changeRequestReviewComment: write('add'),
      changeRequestReviewCommentUpdate: write('update'),
      changeRequestReviewCommentDelete: write('delete'),
      changeRequestReviewDiscard: write('discard'),
    },
  };

  hooks.rememberReviewWriteAccess(context, project, 12, boardAccess);
  const seen: SeenReview = { review: null };
  const Changes: React.FC = () => {
    seen.review = hooks.useComparisonReview({
      selectedSource: { kind: 'pr', number: 12, sourceRepo: { owner: project.owner, repo: project.name } },
      prs: [], readContext: changesContext, provider: 'github',
    }, '/work/app', true).review;
    return null;
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <Changes />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.all(reads); });
  return { seen, writes };
};

describe('a change request opened from the board', () => {
  test('keeps an explicit write denial in Changes: the draft reads, no draft write goes out', async () => {
    const { seen, writes } = await openChanges(false);
    const review = seen.review;
    expect(review?.canWrite).toBe(false);
    expect(review?.state?.draft?.comments.map((comment) => comment.body)).toEqual(['Pending note']);

    expect(await review?.addComment({ path: 'a.ts', side: 'new', line: 3 }, 'More')).toBe(false);
    expect(await review?.updateComment('c1', 'Edited')).toBe(false);
    expect(await review?.deleteComment('c1')).toBe(false);
    expect(await review?.discard()).toBe(false);
    expect(writes).toEqual([]);
  });

  test('an explicit grant on the board lifts an earlier denial', async () => {
    await openChanges(false);
    await act(async () => root.unmount());
    root = createRoot(host);
    const { seen } = await openChanges(true);
    expect(seen.review?.canWrite).toBe(true);
  });

  test('a denial for one account does not reach another', async () => {
    const { seen } = await openChanges(false, { ...context, accountId: 'github.com#8' });
    expect(seen.review?.canWrite).toBe(true);
  });
});
