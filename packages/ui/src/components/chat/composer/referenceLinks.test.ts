import { describe, expect, test } from 'bun:test';

import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';

import type { ComposerReference } from './composerReferences';
import { findReferenceLinks, referenceLinkChip, referenceLinksInText, referencesLinkedIn, referenceTextLink, withMissingReferenceLinks, withReferencesFromText, withoutReferenceSourceLinks, withoutSharedPageLinks } from './referenceLinks';

const urls = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor()], []);
const trackers = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);

const issue: ComposerReference = {
    kind: 'repository-issue', provider: 'github', number: 6649, title: 'Pasted links stay text', url: 'https://github.com/openchamber/openchamber/issues/6649', contextText: 'issue',
};

describe('findReferenceLinks', () => {
    test('finds issue, change request and tracker links, once each, without the punctuation after them', () => {
        const text = [
            'see https://github.com/openchamber/openchamber/issues/6649, and',
            'https://gitlab.com/group/sub/app/-/merge_requests/7.',
            'https://linear.app/openchamber/issue/ope-282/some-title',
            'https://github.com/openchamber/openchamber/issues/6649',
        ].join(' ');
        expect(findReferenceLinks(text, urls, trackers)).toEqual([
            {
                link: 'https://github.com/openchamber/openchamber/issues/6649',
                target: { source: 'repository', provider: 'github', instance: 'github.com', owner: 'openchamber', repo: 'openchamber', kind: 'issue', number: 6649 },
            },
            {
                link: 'https://gitlab.com/group/sub/app/-/merge_requests/7',
                target: { source: 'repository', provider: 'gitlab', instance: 'https://gitlab.com', owner: 'group/sub', repo: 'app', kind: 'pull', number: 7 },
            },
            {
                link: 'https://linear.app/openchamber/issue/ope-282/some-title',
                target: { source: 'tracker', provider: 'linear', identifier: 'OPE-282' },
            },
        ]);
    });

    test('leaves other links and discussions as text', () => {
        const text = 'https://example.com/tickets/12 https://github.com/openchamber/openchamber https://github.com/openchamber/openchamber/discussions/5';
        expect(findReferenceLinks(text, urls, trackers)).toEqual([]);
    });
});

describe('referenceLinksInText', () => {
    test('sends what the text still links, once each', () => {
        const read = new Map([[issue.url, issue]]);
        expect(referenceLinksInText(`${issue.url} and again ${issue.url}`, read)).toEqual([issue]);
        expect(referenceLinksInText('the link was deleted', read)).toEqual([]);
    });
});

test('resolved links merge by change request and preserve the picker content', () => {
    const links = ['https://portal.example/review/42', 'https://portal.example/changes/42', 'https://portal.example/review/77'];
    const mr = (number: number): Extract<ComposerReference, { kind: 'change-request' }> => ({
        kind: 'change-request', provider: 'gitlab', number, title: `MR ${number}`,
        url: `https://gitlab.com/group/app/-/merge_requests/${number}`,
        head: 'branch', base: 'main', includeDiff: false, contextText: `body ${number}`,
    });
    const first = mr(42);
    const second = mr(77);
    const read = new Map([[links[0], first], [links[1], first], [links[2], second]]);
    const text = links.join(' ');
    const resolved = referenceLinksInText(text, read);
    expect(resolved).toEqual([{ ...first, sourceLinks: links.slice(0, 2) }, { ...second, sourceLinks: [links[2]] }]);

    const picker = { ...first, includeDiff: true, contextText: 'picker body and diff' };
    const combined = withReferencesFromText([picker], resolved);
    expect(combined).toEqual([{ ...picker, sourceLinks: links.slice(0, 2) }, resolved[1]]);
    expect(referencesLinkedIn(text, combined)).toEqual(combined);
    expect(withMissingReferenceLinks(text, combined)).toBe(text);
    expect(withMissingReferenceLinks(links[0], [combined[0]])).toBe(links[0]);
});

describe('referenceLinkChip', () => {
    test('labels a chip with the number and title the host writes', () => {
        expect(referenceLinkChip(issue, urls)).toEqual({
            label: '#6649 Pasted links stay text',
            title: '#6649 Pasted links stay text',
            iconHref: '#oc-record-circle',
        });
        const mergeRequest: ComposerReference = {
            kind: 'change-request', provider: 'gitlab', number: 7, title: 'Fix', url: 'https://gitlab.com/group/sub/app/-/merge_requests/7', head: 'a', base: 'b', includeDiff: false, contextText: '',
        };
        expect(referenceLinkChip(mergeRequest, urls)).toMatchObject({ label: '!7 Fix', iconHref: '#oc-git-pull-request' });
    });

    test('a change request chip opens the change request, not the portal link it was pasted as', () => {
        const resolved: ComposerReference = {
            kind: 'change-request', provider: 'gitlab', number: 42, title: 'Fix', url: 'https://gitlab.com/group/app/-/merge_requests/42',
            sourceLinks: ['https://portal.example/review/42'], head: '', base: '', includeDiff: false, contextText: '',
        };
        expect(referenceLinkChip(resolved, urls).openUrl).toBe('https://gitlab.com/group/app/-/merge_requests/42');
    });
});

describe('withoutReferenceSourceLinks', () => {
    const portal = 'https://portal.example/review/42';
    const other = 'https://portal.example/changes/42';
    const restored: ComposerReference = {
        kind: 'change-request', provider: 'gitlab', number: 42, title: 'MR 42', url: 'https://gitlab.com/group/app/-/merge_requests/42',
        sourceLinks: [portal, other], head: '', base: '', includeDiff: false, contextText: 'restored',
    };

    test('a link pasted again no longer keeps the restored change request it named', () => {
        expect(withoutReferenceSourceLinks([restored, issue], new Set([portal]), `see ${portal}`)).toEqual([issue]);
    });

    test('a restored change request that another link in the text still names stays, without the pasted link', () => {
        expect(withoutReferenceSourceLinks([restored], new Set([portal]), `${portal} ${other}`)).toEqual([{ ...restored, sourceLinks: [other] }]);
        expect(withoutReferenceSourceLinks([restored], new Set([portal, other]), `${portal} ${restored.url}`)).toEqual([
            { kind: 'change-request', provider: 'gitlab', number: 42, title: 'MR 42', url: restored.url, head: '', base: '', includeDiff: false, contextText: 'restored' },
        ]);
    });

    test('links nothing restored names leave the list as it is', () => {
        const references = [restored, issue];
        expect(withoutReferenceSourceLinks(references, new Set(['https://portal.example/review/77']), portal)).toBe(references);
    });
});

describe('items as links in the composer text', () => {
    const issue = { kind: 'repository-issue', number: 7, title: 'Bug', url: 'https://github.com/o/r/issues/7', contextText: '' } as const;
    const page = { kind: 'shared-page', shareKey: 'relay.dev/abc', receivedId: null, host: 'relay.dev', title: null, opened: false, contextText: '', link: 'https://relay.dev/p/abc' } as const;

    test('an item goes only while the text holds its link', () => {
        expect(referencesLinkedIn('see https://github.com/o/r/issues/7.', [issue, page])).toEqual([issue]);
    });

    test('putting items back appends the links the text lacks', () => {
        expect(withMissingReferenceLinks('look https://relay.dev/p/abc', [issue, page]))
            .toBe('look https://relay.dev/p/abc https://github.com/o/r/issues/7');
    });

    test('a page chip built before pages had their link falls back to its host and id', () => {
        expect(referenceTextLink({ ...page, link: undefined })).toBe('https://relay.dev/p/abc');
    });

    test('a shared page leaves the sent text, the rest stays', () => {
        expect(withoutSharedPageLinks('read https://relay.dev/p/abc and https://github.com/o/r/issues/7', [issue, page]))
            .toBe('read and https://github.com/o/r/issues/7');
        expect(withoutSharedPageLinks('https://relay.dev/p/abc', [page])).toBe('');
    });
});
