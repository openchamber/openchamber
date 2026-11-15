import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RepositoryIssueReference, RepositoryChangeRequestReference, RepositoryReferenceDetail } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { createWebAPIs } from '../../../../web/src/api';
import { fetchRepositoryReferenceDetail } from '../../../../web/src/api/repository-references';
import { ReferencePreview } from './ReferencePreview';
import type { CachedValue } from './referenceCache';
import type { ReferencePickerItem } from './referencePickerItems';

const readContext = {
    provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo_one',
    accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
} as const;

const issue: RepositoryIssueReference = {
    kind: 'issue', provider: 'github', number: 1, title: 'Tidy the header', url: 'https://github.com/gaojunran/me/issues/1',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: { login: 'gaojunran' },
    labels: [], commentCount: 0, sourceRepo: { owner: 'gaojunran', repo: 'me', source: 'origin' }, state: 'open',
};
const pull: RepositoryChangeRequestReference = {
    kind: 'pull', provider: 'github', number: 12, title: 'Preview layout', url: 'https://github.com/acme/app/pull/12',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: { login: 'octocat' },
    labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc', headRepo: null,
};

const apis = createWebAPIs();

const github = githubLikeDescriptor();
Object.assign(useSourceControlProviderRegistry.getInitialState(), { ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
Object.assign(useTrackerRegistry.getInitialState(), { ordered: [], byId: new Map(), status: 'ready', holdsList: true });

const detailFrom = async <T,>(payload: T, number: number, kind: 'issue' | 'pull'): Promise<RepositoryReferenceDetail> => {
    const result = await fetchRepositoryReferenceDetail(
        async () => Response.json({ connected: true, detail: payload }),
        readContext,
        { owner: kind === 'issue' ? 'gaojunran' : 'acme', repo: kind === 'issue' ? 'me' : 'app', number },
    );
    if (!result.connected || !result.detail) throw new Error('detail expected');
    return result.detail;
};

const render = (item: ReferencePickerItem, detail: RepositoryReferenceDetail, conversationWriteContext = false) => {
    const cached: CachedValue<RepositoryReferenceDetail> = { status: 'ready', value: detail };
    const dom = new Window();
    const container = dom.document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        <RuntimeAPIContext.Provider value={apis}>
            <I18nProvider>
                <ReferencePreview
                    item={item} directory={null} pinned={false} purpose="attach" now={0}
                    pullStatus={{ status: 'idle' }} repositoryDetail={cached} trackerDetail={{ status: 'idle' }}
                    includeDiff onIncludeDiffChange={() => undefined}
                    footer={<button data-footer>Attach</button>}
                    onOpenChecks={() => undefined} onRefresh={async () => undefined}
                    onWriteRefresh={async () => undefined}
                    conversationWriteContext={conversationWriteContext ? readContext : undefined}
                />
            </I18nProvider>
        </RuntimeAPIContext.Provider>,
    );
    return container;
};

describe('ReferencePreview on the host detail path', () => {
    test('shows the issue assignees the host reports', async () => {
        const detail = await detailFrom({
            number: 1, comments: [], commentTotal: 0, pull: null,
            assignees: [{ id: 'gaojunran', login: 'gaojunran' }], writeAccess: true,
        }, 1, 'issue');

        const container = render({ source: 'repository', reference: issue }, detail);

        expect(container.textContent).toContain('gaojunran');
        expect(container.textContent).not.toContain('Unassigned');
    });

    test('hides the base editor when the host says this account may not write', async () => {
        const detail = await detailFrom({
            number: 12, comments: [], commentTotal: 0,
            pull: { reviewDecision: null, reviewers: [], additions: 0, deletions: 0, changedFiles: 0, commits: [], commitTotal: 0 },
            writeAccess: false,
        }, 12, 'pull');

        const container = render({ source: 'repository', reference: pull }, detail, true);

        expect(container.querySelector('[aria-label="Edit base branch"]')).toBeNull();
    });

    test('keeps the base editor when the host does not report write access', async () => {
        const detail = await detailFrom({
            number: 12, comments: [], commentTotal: 0,
            pull: { reviewDecision: null, reviewers: [], additions: 0, deletions: 0, changedFiles: 0, commits: [], commitTotal: 0 },
        }, 12, 'pull');

        const container = render({ source: 'repository', reference: pull }, detail, true);

        expect(container.querySelector('[aria-label="Edit base branch"]')).not.toBeNull();
    });
});
