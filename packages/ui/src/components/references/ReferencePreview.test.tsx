import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { GitHubPullReference, GitHubReferenceDetail, LinearIssue } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { createWebAPIs } from '../../../../web/src/api';
import { ReferencePreview } from './ReferencePreview';
import type { CachedValue } from './referenceCache';
import type { ReferencePickerItem } from './referencePickerItems';

const pull: GitHubPullReference = {
    kind: 'pull', number: 12, title: 'Preview layout', url: 'https://github.com/acme/app/pull/12',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null,
    author: { login: 'octocat' }, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc', headRepo: null,
};
const githubDetail: GitHubReferenceDetail = {
    number: 12, comments: [], commentTotal: 0,
    pull: {
        additions: 3, deletions: 1, changedFiles: 1, reviewDecision: 'approved', reviewers: [],
        checks: { state: 'success', total: 2, success: 2, failure: 0, pending: 0 },
        commits: [], commitTotal: 0,
    },
};
const issue: LinearIssue = {
    id: 'issue', identifier: 'ENG-12', title: 'Preview layout', url: 'https://linear.app/acme/issue/ENG-12',
    state: { id: 'started', name: 'In progress', type: 'started' },
    assignee: { name: 'alex', displayName: 'Alex', avatarUrl: null },
    team: { id: 'eng', key: 'ENG', name: 'Engineering' }, priority: 2, labels: [],
    description: '', comments: [],
};

const items: ReferencePickerItem[] = [{ source: 'github', reference: pull }, { source: 'linear', issue }];
const apis = createWebAPIs();

function renderPreview(item: ReferencePickerItem, pinned: boolean, status: 'ready' | 'loading' | 'error' = 'ready', customFooter = true, linearIssue: LinearIssue = issue) {
    const pending = status === 'error' ? { status, error: 'Host unavailable' } as const : { status: 'loading' } as const;
    const github: CachedValue<GitHubReferenceDetail> = status === 'ready' ? { status, value: githubDetail } : pending;
    const linear: CachedValue<LinearIssue> = status === 'ready' ? { status, value: linearIssue } : pending;
    const dom = new Window();
    const container = dom.document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        <RuntimeAPIContext.Provider value={apis}>
            <I18nProvider>
                <ReferencePreview
                    item={item} directory={null} pinned={pinned} purpose="attach" now={0}
                    pullStatus={{ status: 'idle' }} githubDetail={github} linearDetail={linear}
                    includeDiff onIncludeDiffChange={() => undefined}
                    footer={customFooter ? <button data-footer>Attach</button> : undefined}
                    labelsControl={<button>Edit labels</button>}
                    reviewersControl={<button>Edit reviewers</button>}
                    onOpenChecks={() => undefined} onRefresh={async () => undefined}
                />
            </I18nProvider>
        </RuntimeAPIContext.Provider>,
    );
    return container;
}

describe('ReferencePreview layout', () => {
    for (const item of items) {
        for (const status of ['ready', 'loading', 'error'] as const) {
            test(`${item.source} pinned preview scrolls metadata before the body with ${status} detail`, () => {
                const container = renderPreview(item, true, status);
                const scroller = container.querySelector('.overlay-scrollbar-container');
                const meta = container.querySelector('dl');
                const header = container.querySelector('header');
                const footer = container.querySelector('[data-footer]');

                if (!meta) throw new Error('Expected preview metadata');
                if (!header) throw new Error('Expected preview header');
                if (!footer) throw new Error('Expected preview footer');

                expect(scroller?.contains(meta)).toBe(true);
                expect(scroller?.classList.contains('overflow-y-auto')).toBe(true);
                expect(scroller?.querySelector('article')?.firstElementChild).toBe(meta);
                expect(scroller?.contains(header)).toBe(false);
                expect(header?.querySelector('h3')?.textContent).toBe('Preview layout');
                expect(header?.querySelector('a')?.textContent).toBe(item.source === 'github' ? 'GitHub' : 'Linear');
                expect(header?.parentElement?.classList.contains('shrink-0')).toBe(true);
                expect(header?.parentElement?.classList.contains('border-b')).toBe(true);
                expect(header?.parentElement?.querySelector('dl')).toBeNull();
                expect(scroller?.contains(footer)).toBe(false);
                expect(footer?.parentElement?.classList.contains('shrink-0')).toBe(true);
                expect(footer?.parentElement?.classList.contains('border-t')).toBe(true);
                expect(scroller?.parentElement?.nextElementSibling).toBe(footer?.parentElement);
                if (item.source === 'github') {
                    expect(meta?.textContent).toContain('octocat');
                    expect(meta?.textContent).toContain('feature');
                    expect(meta?.textContent).toContain('Edit labels');
                    expect(meta?.textContent).toContain('Edit reviewers');
                    expect(header?.querySelector('button[aria-label="Refresh"]')).not.toBeNull();
                    if (status === 'ready') expect(meta?.textContent).toContain('All passed');
                } else {
                    expect(meta?.textContent).toContain('Alex');
                    expect(meta?.textContent).toContain('Engineering');
                }
                if (status === 'error') expect(scroller?.textContent).toContain('Host unavailable');
            });
        }

        test(`${item.source} inline preview keeps header, metadata, body and footer in one flow`, () => {
            const container = renderPreview(item, false);
            const article = container.querySelector('article');
            expect(container.querySelector('.overlay-scrollbar-container')).toBeNull();
            expect(article?.firstElementChild?.tagName).toBe('HEADER');
            expect(article?.children[1]?.querySelector('dl')).not.toBeNull();
            expect(article?.children[1]?.classList.contains('border-b')).toBe(true);
            expect(article?.lastElementChild?.querySelector('[data-footer]')).not.toBeNull();
        });
    }

    test('the picker diff option stays in the pinned footer', () => {
        const container = renderPreview(items[0], true, 'ready', false);
        const checkbox = container.querySelector('input[type="checkbox"]');
        expect(checkbox).not.toBeNull();
        if (!checkbox) throw new Error('Expected picker diff checkbox');
        expect(checkbox?.closest('.overlay-scrollbar-container')).toBeNull();
        expect(container.lastElementChild?.lastElementChild?.contains(checkbox)).toBe(true);
    });
});

describe('ReferencePreview Linear commentsMore (#1781)', () => {
    const comment = { id: 'c1', body: 'First page comment', createdAt: null, user: { name: 'alex', displayName: 'Alex' } };
    test('commentsMore renders a linked truncation note in the comments area', () => {
        const container = renderPreview(items[1], false, 'ready', true, { ...issue, comments: [comment], commentsMore: true });
        expect(container.textContent).toContain('First 1 comments shown, all of them in Linear');
        const links = Array.from(container.querySelectorAll('a'));
        expect(links.some((a) => a.textContent?.includes('comments shown') && a.getAttribute('href') === issue.url)).toBe(true);
    });
    test('no truncation note when commentsMore is absent', () => {
        const container = renderPreview(items[1], false, 'ready', true, { ...issue, comments: [comment] });
        expect(container.textContent).not.toContain('comments shown, all of them in Linear');
    });
});

describe('ReferencePreview Linear labelsMore (#1782)', () => {
    const label = { id: 'l1', name: 'bug', color: '#ff0000' };
    test('labelsMore renders a linked truncation note beside the label chips', () => {
        const container = renderPreview(items[1], false, 'ready', true, { ...issue, labels: [label], labelsMore: true });
        expect(container.textContent).toContain('First 1 labels shown, all of them in Linear');
        const links = Array.from(container.querySelectorAll('a'));
        expect(links.some((a) => a.textContent?.includes('labels shown') && a.getAttribute('href') === issue.url)).toBe(true);
    });
    test('no truncation note when labelsMore is absent', () => {
        const container = renderPreview(items[1], false, 'ready', true, { ...issue, labels: [label] });
        expect(container.textContent).not.toContain('labels shown, all of them in Linear');
    });
});
