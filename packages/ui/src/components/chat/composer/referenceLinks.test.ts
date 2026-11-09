import { describe, expect, test } from 'bun:test';

import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';

import type { ComposerReference } from './composerReferences';
import { findReferenceLinks, referenceLinkChip, referenceLinksInText } from './referenceLinks';

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
});
