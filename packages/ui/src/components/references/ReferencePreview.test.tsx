import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RepositoryChangeRequestReference, RepositoryReferenceDetail, TrackerItem } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { createWebAPIs } from '../../../../web/src/api';
import { ReferencePreview } from './ReferencePreview';
import type { CachedValue } from './referenceCache';
import type { ReferencePickerItem } from './referencePickerItems';

const pull: RepositoryChangeRequestReference = {
    kind: 'pull', provider: 'github', number: 12, title: 'Preview layout', url: 'https://github.com/acme/app/pull/12',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null,
    author: { login: 'octocat' }, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc', headRepo: null,
};
const repositoryDetail: RepositoryReferenceDetail = {
    number: 12, comments: [], commentTotal: 0,
    pull: {
        additions: 3, deletions: 1, changedFiles: 1, reviewDecision: 'approved', reviewers: [],
        checks: { state: 'success', total: 2, success: 2, failure: 0, pending: 0 },
        commits: [], commitTotal: 0,
    },
};
const issue: TrackerItem = {
    provider: 'linear', id: 'issue', identifier: 'ENG-12', title: 'Preview layout', url: 'https://linear.app/acme/issue/ENG-12',
    state: { id: 'started', name: 'In progress', category: 'in-progress' },
    assignee: { name: 'Alex', avatarUrl: null },
    container: { id: 'eng', key: 'ENG', name: 'Engineering' }, priority: 'high', labels: [],
    description: '', comments: [],
};

const items: ReferencePickerItem[] = [{ source: 'repository', reference: pull }, { source: 'tracker', provider: 'linear', item: issue }];
const apis = createWebAPIs();

// Static rendering reads the provider registry's first state, not its current one.
const github = githubLikeDescriptor();
Object.assign(useSourceControlProviderRegistry.getInitialState(), { ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
const linear = linearLikeTrackerDescriptor();
Object.assign(useTrackerRegistry.getInitialState(), { ordered: [linear], byId: new Map([[linear.id, linear]]), status: 'ready', holdsList: true });

function renderPreview(item: ReferencePickerItem, pinned: boolean, status: 'ready' | 'loading' | 'error' = 'ready', customFooter = true) {
    const pending = status === 'error' ? { status, error: 'Host unavailable' } as const : { status: 'loading' } as const;
    const github: CachedValue<RepositoryReferenceDetail> = status === 'ready' ? { status, value: repositoryDetail } : pending;
    const tracker: CachedValue<TrackerItem> = status === 'ready' ? { status, value: issue } : pending;
    const dom = new Window();
    const container = dom.document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        <RuntimeAPIContext.Provider value={apis}>
            <I18nProvider>
                <ReferencePreview
                    item={item} directory={null} pinned={pinned} purpose="attach" now={0}
                    pullStatus={{ status: 'idle' }} repositoryDetail={github} trackerDetail={tracker}
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
                // The meta grid opens the scroll, its divider below it.
                expect(scroller?.querySelector('article')?.firstElementChild).toBe(meta?.parentElement ?? null);
                expect(meta?.parentElement?.classList.contains('border-b')).toBe(true);
                expect(scroller?.contains(header)).toBe(false);
                expect(header?.querySelector('h3')?.textContent).toBe('Preview layout');
                expect(header?.querySelector('a')?.textContent).toBe(item.source === 'repository' ? 'GitHub' : 'Linear');
                expect(header?.parentElement?.classList.contains('shrink-0')).toBe(true);
                expect(header?.parentElement?.classList.contains('border-b')).toBe(true);
                expect(header?.parentElement?.querySelector('dl')).toBeNull();
                expect(scroller?.contains(footer)).toBe(false);
                expect(footer?.parentElement?.classList.contains('shrink-0')).toBe(true);
                expect(footer?.parentElement?.classList.contains('border-t')).toBe(true);
                expect(scroller?.parentElement?.nextElementSibling).toBe(footer?.parentElement);
                if (item.source === 'repository') {
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
