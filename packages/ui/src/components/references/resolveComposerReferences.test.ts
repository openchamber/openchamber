import { describe, expect, spyOn, test } from 'bun:test';

import type { RepositoryDiscussionReference, RepositoryItemRef, RepositoryReferenceDetail, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';

import { resolveComposerReferences, resolveReferenceLink } from './resolveComposerReferences';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { findReferenceLinks } from '@/components/chat/composer/referenceLinks';

const context: SourceControlReadContext = {
    directory: '/repo', provider: 'github', instance: 'github.com', repositoryId: 'repo-one', accountId: 'acc', bindingRevision: 1, primaryRemote: 'origin',
};

const discussion: RepositoryDiscussionReference = {
    kind: 'discussion',
    provider: 'github',
    number: 5,
    title: 'How do I move sessions?',
    url: 'https://github.com/acme/app/discussions/5',
    body: 'Steps',
    bodyTruncated: false,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    author: { login: 'asker' },
    labels: [{ name: 'question' }],
    commentCount: 1,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open',
    answered: true,
    upvotes: 2,
    locked: false,
    category: { name: 'Q&A', emoji: '🙏', answerable: true },
};

const comment = (body: string) => ({ author: { login: 'helper' }, body, createdAt: '2026-10-01T11:00:00Z', url: `u-${body}`, path: null, line: null, review: null });

const detail: RepositoryReferenceDetail = {
    number: 5,
    comments: [{
        ...comment('Use export'),
        thread: { id: 'DC_1', resolved: false, canResolve: false, canReply: true, replies: [comment('Thanks')] },
        answer: { chosen: true, canChange: false },
    }],
    commentTotal: 1,
    pull: null,
    discussion: { canComment: true, canClose: false, canReopen: false },
};

describe('resolveComposerReferences', () => {
    test('attaches a discussion with its comments, their replies and which one is the answer', async () => {
        const asked: Array<RepositoryItemRef & { kind?: 'discussion' }> = [];
        const unexpected = () => Promise.reject(new Error('not read for a discussion'));
        const sourceControl: Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'> = {
            issueGet: unexpected,
            issueComments: unexpected,
            changeRequestContext: unexpected,
            referenceDetail: async (_context, ref) => {
                asked.push(ref);
                return { connected: true, detail };
            },
        };
        const result = await resolveComposerReferences([{ source: 'repository', reference: discussion, includeDiff: false }], {
            sourceControl,
            context,
            readTrackerDetail: unexpected,
            trackerName: () => '',
        });

        expect(result.failures).toEqual([]);
        expect(asked).toEqual([{ owner: 'acme', repo: 'app', number: 5, kind: 'discussion' }]);
        const [reference] = result.references;
        expect(reference).toMatchObject({ kind: 'repository-discussion', provider: 'github', number: 5, url: discussion.url, author: { login: 'asker' } });
        if (reference?.kind !== 'repository-discussion') throw new Error('expected a discussion');
        const [header, ...json] = reference.contextText.split('\n');
        expect(header).toBe('Source control discussion context (JSON)');
        expect(JSON.parse(json.join('\n'))).toMatchObject({
            project: { owner: 'acme', name: 'app' },
            discussion: { number: 5, state: 'open', category: 'Q&A', answered: true, labels: ['question'], body: 'Steps', bodyTruncated: false },
            commentTotal: 1,
            comments: [{ author: 'helper', body: 'Use export', isAnswer: true, replies: [{ author: 'helper', body: 'Thanks' }] }],
        });
    });

    test('reports a discussion its host cannot read and attaches nothing for it', async () => {
        const unexpected = () => Promise.reject(new Error('not read for a discussion'));
        const result = await resolveComposerReferences([{ source: 'repository', reference: discussion, includeDiff: false }], {
            sourceControl: { issueGet: unexpected, issueComments: unexpected, changeRequestContext: unexpected, referenceDetail: async () => ({ connected: true, detail: null }) },
            context,
            readTrackerDetail: unexpected,
            trackerName: () => '',
        });
        expect(result.references).toEqual([]);
        expect(result.failures).toEqual([{ key: 'github:acme/app~5', label: '#5', error: 'Discussion not found' }]);
    });
});

describe('resolveReferenceLink', () => {
    const unexpected = () => Promise.reject(new Error('not read for an issue'));
    const issueLink = { source: 'repository', provider: 'github', instance: 'github.com', owner: 'other', repo: 'lib', kind: 'issue', number: 9 } as const;

    test('reads an issue past the fork network again as a linked item', async () => {
        const reads: Array<{ linked: boolean; project: unknown }> = [];
        const sourceControl: Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'> = {
            issueGet: async (through, number, project) => {
                reads.push({ linked: through.linked === true, project });
                if (!through.linked) throw new Error('Not in this repository network');
                return {
                    provider: 'github', instance: 'github.com', id: 'I_9', number, title: 'Crash', url: 'https://github.com/other/lib/issues/9', state: 'open',
                    project: { provider: 'github', instance: 'github.com', id: 'other/lib', owner: 'other', name: 'lib', url: 'https://github.com/other/lib' },
                    author: { provider: 'github', instance: 'github.com', id: '1', username: 'reporter' },
                };
            },
            issueComments: async () => [],
            changeRequestContext: unexpected,
            referenceDetail: unexpected,
        };
        const reference = await resolveReferenceLink(issueLink, { sourceControl, context, readTrackerDetail: unexpected, trackerName: () => '' });
        expect(reads).toEqual([{ linked: false, project: { owner: 'other', name: 'lib' } }, { linked: true, project: { owner: 'other', name: 'lib' } }]);
        expect(reference).toMatchObject({ kind: 'repository-issue', number: 9, title: 'Crash', author: { login: 'reporter' } });
    });

    test('reads nothing for a link on another host than the project', async () => {
        const deps = { sourceControl: { issueGet: unexpected, issueComments: unexpected, changeRequestContext: unexpected, referenceDetail: unexpected }, context, readTrackerDetail: unexpected, trackerName: () => '' };
        await expect(resolveReferenceLink({ ...issueLink, provider: 'gitlab', instance: 'gitlab.com' }, deps)).rejects.toThrow('The repository is not available here');
    });
});

test('a known native provider wins over an extension resolver on the same origin', () => {
    const native = gitlabLikeDescriptor();
    const extension = gitlabLikeDescriptor();
    extension.id = 'ext-demo';
    extension.urls.resolve = '/handle-url';
    extension.extension = { guestId: 'demo', name: 'Demo', version: '1.0.0' };
    const instance = 'https://forge.example.test';
    const alias = 'https://review.example.test';
    const urls = createRepositoryUrlMatcher([githubLikeDescriptor(), native, extension], [
        { provider: native.id, instance }, { provider: extension.id, instance, instanceAliases: [alias] },
    ]);
    const [link] = findReferenceLinks(`${instance}/team/app/-/merge_requests/42`, urls, createTrackerUrlMatcher([]));
    expect(link.target).toMatchObject({ source: 'repository', provider: native.id, instance, number: 42 });
    expect(urls.resolverFor?.(`${alias}/team/app/pull/42`)).toMatchObject({ provider: extension.id, instance });
});

test('a declared service path converts an alias template miss before the native MR read', async () => {
    const descriptor = gitlabLikeDescriptor();
    descriptor.id = 'ext-demo';
    descriptor.urls.resolve = '/handle-url';
    descriptor.extension = { guestId: 'demo', name: 'Demo', version: '1.0.0' };
    const instance = 'https://forge.example.test';
    const alias = 'https://review.example.test';
    const through = { ...context, provider: descriptor.id, instance };
    const urls = createRepositoryUrlMatcher([descriptor], [{ provider: descriptor.id, instance, instanceAliases: [alias] }]);
    const canonical = `${instance}/team/app/-/merge_requests/42`;
    const trackers = createTrackerUrlMatcher([]);
    const requests: unknown[] = [];
    let answer: { url: string } | null = { url: canonical };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 200, body: JSON.stringify(answer) });
    });
    const reads: Parameters<SourceControlAPI['changeRequestContext']>[] = [];
    const unexpected = () => Promise.reject(new Error('unexpected read'));
    const deps = {
        context: through, readTrackerDetail: unexpected, trackerName: () => '',
        sourceControl: {
            issueGet: unexpected, issueComments: unexpected, referenceDetail: unexpected,
            changeRequestContext: async (...args: Parameters<SourceControlAPI['changeRequestContext']>) => {
                reads.push(args);
                const project = { provider: descriptor.id, instance, id: 'team/app', owner: 'team', name: 'app', url: `${instance}/team/app` };
                return { identity: through, project, files: [], issueComments: [], reviewComments: [], changeRequest: {
                    provider: descriptor.id, instance, project, id: '42', number: 42, title: 'Synthetic review', url: canonical,
                    state: 'open' as const, draft: false, head: 'feature', base: 'main',
                } };
            },
        },
    };
    try {
        const portal = `${alias}/objects/300`;
        const targets = findReferenceLinks(portal, urls, trackers);
        expect(targets).toHaveLength(1);
        expect(await resolveReferenceLink(targets[0].target, deps)).toMatchObject({ kind: 'change-request', number: 42, url: canonical });
        expect(requests).toEqual([{ method: 'POST', path: '/handle-url', body: JSON.stringify({ url: portal, instance }) }]);
        expect(reads).toEqual([[through, 42, { includeDiff: false, includeCIDetails: false, project: { owner: 'team', name: 'app' } }]]);
        expect(urls.resolverFor?.(`${alias}/team/app/-/merge_requests/42`)).toMatchObject({ provider: descriptor.id, instance });
        expect(urls.resolverFor?.('https://unregistered.example.test/objects/300')).toBeNull();
        answer = null;
        expect(await resolveReferenceLink(targets[0].target, deps)).toBeNull();
        answer = { url: canonical.replace('forge.example.test', 'other.example.test') };
        await expect(resolveReferenceLink(targets[0].target, deps)).rejects.toThrow('another provider instance');
        expect(reads).toHaveLength(1);
    } finally {
        fetch.mockRestore();
    }
});

describe('portal conversion through an extension', () => {
    const instance = 'https://forge.example.test';
    const alias = 'https://review.example.test';
    const canonical = `${instance}/team/app/-/merge_requests/42`;
    const extensionDescriptor = () => {
        const descriptor = gitlabLikeDescriptor();
        descriptor.id = 'ext-demo';
        descriptor.urls.resolve = '/handle-url';
        descriptor.extension = { guestId: 'demo', name: 'Demo', version: '1.0.0' };
        return descriptor;
    };
    const depsFor = (provider: string) => {
        const through = { ...context, provider, instance };
        const unexpected = () => Promise.reject(new Error('unexpected read'));
        return {
            context: through, readTrackerDetail: unexpected, trackerName: () => '',
            sourceControl: {
                issueGet: unexpected, issueComments: unexpected, referenceDetail: unexpected,
                changeRequestContext: async () => {
                    const project = { provider, instance, id: 'team/app', owner: 'team', name: 'app', url: `${instance}/team/app` };
                    return { identity: through, project, files: [], issueComments: [], reviewComments: [], changeRequest: {
                        provider, instance, project, id: '42', number: 42, title: 'Synthetic review', url: canonical,
                        state: 'open' as const, draft: false, head: 'feature', base: 'main',
                    } };
                },
            },
        };
    };
    const answering = (url: string) => spyOn(globalThis, 'fetch').mockImplementation(async () => (
        Response.json({ status: 200, body: JSON.stringify({ url }) })
    ));

    test('a built-in provider on the same origin does not claim the converted address', async () => {
        const native = gitlabLikeDescriptor();
        const extension = extensionDescriptor();
        const urls = createRepositoryUrlMatcher([native, extension], [
            { provider: native.id, instance }, { provider: extension.id, instance, instanceAliases: [alias] },
        ]);
        const fetch = answering(canonical);
        try {
            const [link] = findReferenceLinks(`${alias}/objects/300`, urls, createTrackerUrlMatcher([]));
            expect(link.target).toMatchObject({ source: 'repository-url', provider: extension.id, instance });
            expect(await resolveReferenceLink(link.target, depsFor(extension.id))).toMatchObject({ kind: 'change-request', number: 42, url: canonical });
        } finally {
            fetch.mockRestore();
        }
    });

    test('an issue answer draws no chip', async () => {
        const extension = extensionDescriptor();
        const urls = createRepositoryUrlMatcher([extension], [{ provider: extension.id, instance, instanceAliases: [alias] }]);
        const fetch = answering(`${instance}/team/app/-/issues/42`);
        try {
            const [link] = findReferenceLinks(`${alias}/objects/300`, urls, createTrackerUrlMatcher([]));
            expect(await resolveReferenceLink(link.target, depsFor(extension.id))).toBeNull();
        } finally {
            fetch.mockRestore();
        }
    });
});
