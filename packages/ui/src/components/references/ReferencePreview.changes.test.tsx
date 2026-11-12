import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { ChangeRequestRevision, RepositoryChangeRequestReference, RepositoryReferenceDetail } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { changeHostDescriptor, githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { createWebAPIs } from '../../../../web/src/api';
import { ReferencePreview, type RevisionChoice } from './ReferencePreview';

const change: RepositoryChangeRequestReference = {
    kind: 'pull', provider: 'review-host', number: 4321, title: 'Login flow', url: 'https://review.example.com/c/app/+/4321',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open', draft: true, head: 'refs/changes/21/4321/2', base: 'main', headSha: 'b'.repeat(40), headRepo: null,
    workInProgress: true, private: true, topic: 'login', revisionNumber: 2,
};
const revision = (number: number, sha: string): ChangeRequestRevision => ({
    number, sha, createdAt: null, ref: `refs/changes/21/4321/${number}`, kind: number === 2 ? 'trivial-rebase' : 'rework',
});
const detail: RepositoryReferenceDetail = {
    number: 4321, comments: [], commentTotal: 0,
    pull: { additions: 3, deletions: 1, changedFiles: 1, reviewDecision: null, reviewers: [], commits: [], commitTotal: 0 },
};

// Static rendering reads the provider registry's first state.
const descriptors = [githubLikeDescriptor(), changeHostDescriptor()];
Object.assign(useSourceControlProviderRegistry.getInitialState(), {
    ordered: descriptors, byId: new Map(descriptors.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true,
});
const apis = createWebAPIs();

const renderChange = (reference: RepositoryChangeRequestReference, revisionChoice?: RevisionChoice) => {
    const dom = new Window();
    const container = dom.document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        <RuntimeAPIContext.Provider value={apis}>
            <I18nProvider>
                <ReferencePreview
                    item={{ source: 'repository', reference }} directory={null} pinned purpose="attach" now={0}
                    pullStatus={{ status: 'idle' }} repositoryDetail={{ status: 'ready', value: detail }} trackerDetail={{ status: 'idle' }}
                    includeDiff={false} onIncludeDiffChange={() => undefined} revisionChoice={revisionChoice}
                />
            </I18nProvider>
        </RuntimeAPIContext.Provider>,
    );
    return container;
};

const choiceOf = (revisions: ChangeRequestRevision[]): RevisionChoice => ({ revisions, selected: null, onSelect: () => undefined });

describe('a change in the preview', () => {
    test('offers a revision picker only when there is more than one revision, on the latest by default', () => {
        expect(renderChange(change, choiceOf([revision(1, 'a'.repeat(40))])).querySelector('button[aria-label="Patchset"]')).toBeNull();
        expect(renderChange(change).querySelector('button[aria-label="Patchset"]')).toBeNull();
        const picker = renderChange(change, choiceOf([revision(1, 'a'.repeat(40)), revision(2, 'b'.repeat(40))]))
            .querySelector('button[aria-label="Patchset"]');
        expect(picker?.textContent).toBe('Patchset 2, latest');
    });

    test('a forge never shows the picker, whatever it is handed', () => {
        const pull = { ...change, provider: 'github', workInProgress: undefined, private: undefined, topic: undefined };
        expect(renderChange(pull, choiceOf([revision(1, 'a'.repeat(40)), revision(2, 'b'.repeat(40))])).querySelector('button[aria-label="Patchset"]')).toBeNull();
    });

    test('shows private and the topic, and the target branch in place of a head branch', () => {
        const container = renderChange(change);
        const header = container.querySelector('header');
        // The pill says Draft already, so work in progress is not said again.
        expect(header?.textContent).toContain('Draft');
        expect(header?.textContent).not.toContain('Work in progress');
        expect(renderChange({ ...change, draft: false }).querySelector('header')?.textContent).toContain('Work in progress');
        expect(header?.textContent).toContain('Private');
        expect(header?.textContent).toContain('Topic: login');
        const meta = container.querySelector('dl');
        expect(meta?.textContent).toContain('main');
        expect(meta?.textContent).not.toContain('refs/changes/21/4321/2');
    });
});
