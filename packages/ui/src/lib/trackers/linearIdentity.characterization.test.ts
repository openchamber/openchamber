// Characterisation of the Linear identity strings and agent text that the
// tracker refactor must keep byte-identical (persisted data, session metadata,
// open tabs). The agent context text changed shape on purpose with the
// tracker contract: it is now the neutral item, the same for every tracker.
import { describe, expect, test } from 'bun:test';

import { composerReferenceKey, toLinkedIssue } from '@/components/chat/composer/composerReferences';
import { resolveComposerReferences } from '@/components/references/resolveComposerReferences';
import {
    TRACKER_PEOPLE_FILTERS,
    TRACKER_PRIORITY_FILTERS,
    referencePickerItemKey,
} from '@/components/references/referencePickerItems';
import { trackerTargetOfUrl } from '@/components/sourceBoard/openTrackerItem';
import type { SourceControlAPI, TrackerItem, TrackerItemSummary } from '@/lib/api/types';
import { buildLinkedTrackerItem } from '@/lib/linkedIssues';
import { workItem } from '@/lib/trackedItems/fromLinks';
import { trackedItemKey } from '@/lib/trackedItems/model';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { linearLikeTrackerDescriptor } from './descriptor.fixture';
import { buildTrackerItemContextText } from './itemContext';
import { LINEAR_URL_CASES } from './linearUrlCases.fixture';
import { createTrackerUrlMatcher } from './matchTrackerUrl';
import { trackerPresentation } from './presentation';

// Linear links read the same whatever source-control providers are registered.
const NO_REPOSITORY_URLS = createRepositoryUrlMatcher([], []);
const TRACKER_URLS = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);

const summary: TrackerItemSummary = {
    provider: 'linear',
    id: '11111111-2222-3333-4444-555555555555',
    identifier: 'ENG-12',
    title: 'Broken login',
    url: 'https://linear.app/openchamber/issue/ENG-12/broken-login',
    state: { id: 'state-started', name: 'In Progress', category: 'in-progress' },
    priority: 'urgent',
    labels: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }],
    assignee: { name: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
    container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    parent: null,
    progress: { total: 2, done: 1, more: false },
    updatedAt: '2026-09-30T10:00:00.000Z',
};

const issue: TrackerItem = {
    ...summary,
    description: 'Users cannot sign in.',
    comments: [{
        id: 'comment-1',
        body: 'Still broken',
        createdAt: '2026-09-30T11:00:00.000Z',
        author: { name: 'Bob B', avatarUrl: null },
    }],
    children: [],
    childrenMore: false,
};

describe('Linear identity strings', () => {
    test('tracked-items key is linear|IDENTIFIER, upper-cased', () => {
        expect(trackedItemKey({ provider: 'linear', kind: 'work-item', identifier: 'ENG-12' })).toBe('linear|ENG-12');
        expect(trackedItemKey({ provider: 'linear', kind: 'work-item', identifier: 'eng-12' })).toBe('linear|ENG-12');
        expect(trackedItemKey(workItem('linear', 'eng-12'))).toBe('linear|ENG-12');
        expect(workItem('linear', 'eng-12')).toEqual({ provider: 'linear', kind: 'work-item', identifier: 'ENG-12' });
    });

    test('a Linear link opens a Tracker tab keyed linear:IDENTIFIER', () => {
        const target = trackerTargetOfUrl('https://linear.app/openchamber/issue/eng-12/broken-login', NO_REPOSITORY_URLS, TRACKER_URLS);
        expect(target).toEqual({ source: 'tracker', provider: 'linear', identifier: 'ENG-12' });
        // The tab key `openTrackerItem.ts` builds from that target.
        if (target?.source !== 'tracker') throw new Error('expected a tracker target');
        expect(`${target.provider}:${target.identifier}`).toBe('linear:ENG-12');
    });

    test('the URL table the server matcher shares', () => {
        for (const [url, identifier] of LINEAR_URL_CASES) {
            const target = trackerTargetOfUrl(url, NO_REPOSITORY_URLS, TRACKER_URLS);
            expect(target?.source === 'tracker' ? target.identifier : null).toBe(identifier);
        }
    });

    test('linked-issue id is linear:IDENTIFIER as given; the entry is a Linear tracker item', () => {
        const linked = buildLinkedTrackerItem({
            provider: 'linear',
            identifier: 'ENG-12',
            title: 'Broken login',
            url: summary.url,
            author: { login: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
            linkedAt: 1,
        });
        expect(linked).toEqual({
            id: 'linear:ENG-12',
            kind: 'tracker',
            provider: 'linear',
            identifier: 'ENG-12',
            title: 'Broken login',
            url: summary.url,
            author: 'Ada Lovelace',
            authorAvatarUrl: 'https://example.com/a.png',
            linkedAt: 1,
        });
        // The id keeps the identifier's case; callers pass Linear's upper-case one.
        expect(buildLinkedTrackerItem({ provider: 'linear', identifier: 'eng-12', title: 't', url: 'u', linkedAt: 1 }).id).toBe('linear:eng-12');
    });

    test('picker and composer keys are linear:IDENTIFIER, upper-cased', () => {
        expect(referencePickerItemKey({ source: 'tracker', provider: 'linear', item: { ...summary, identifier: 'eng-12' } })).toBe('linear:ENG-12');
        expect(composerReferenceKey({ kind: 'tracker-item', provider: 'linear', identifier: 'eng-12', title: 't', url: 'u', contextText: '' })).toBe('linear:ENG-12');
        expect(toLinkedIssue({ kind: 'tracker-item', provider: 'linear', identifier: 'ENG-12', title: 't', url: 'u', contextText: '' }, 1).id).toBe('linear:ENG-12');
    });

    test('a branch started from an issue is issue-IDENTIFIER, before the dialog adds its slug', () => {
        expect(trackerPresentation('linear').branchName({ identifier: 'ENG-12' })).toBe('issue-ENG-12');
    });
});

describe('Linear agent context text', () => {
    test('is the tracker name\'s header, then the neutral item and its comments as indented JSON', () => {
        const { comments, ...fields } = issue;
        expect(buildTrackerItemContextText(issue, 'Linear'))
            .toBe(`Linear issue context (JSON)\n${JSON.stringify({ item: fields, comments }, null, 2)}`);
    });

    test('attaching an issue sends the neutral item, its comments once', async () => {
        const result = await resolveComposerReferences([{ source: 'tracker', provider: 'linear', item: summary }], {
            // SAFETY: the tracker branch never reads source control.
            sourceControl: {} as Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext'>,
            context: null,
            readTrackerDetail: async () => issue,
            trackerName: () => 'Linear',
        });
        expect(result.failures).toEqual([]);
        const [reference] = result.references;
        expect(reference).toEqual({
            kind: 'tracker-item',
            provider: 'linear',
            identifier: 'ENG-12',
            title: 'Broken login',
            url: summary.url,
            contextText: [
                'Linear issue context (JSON)',
                '{',
                '  "item": {',
                '    "provider": "linear",',
                '    "id": "11111111-2222-3333-4444-555555555555",',
                '    "identifier": "ENG-12",',
                '    "title": "Broken login",',
                '    "url": "https://linear.app/openchamber/issue/ENG-12/broken-login",',
                '    "state": {',
                '      "id": "state-started",',
                '      "name": "In Progress",',
                '      "category": "in-progress"',
                '    },',
                '    "priority": "urgent",',
                '    "labels": [',
                '      {',
                '        "id": "label-bug",',
                '        "name": "Bug",',
                '        "color": "#eb5757"',
                '      }',
                '    ],',
                '    "assignee": {',
                '      "name": "Ada Lovelace",',
                '      "avatarUrl": "https://example.com/a.png"',
                '    },',
                '    "container": {',
                '      "id": "team-eng",',
                '      "key": "ENG",',
                '      "name": "Engineering"',
                '    },',
                '    "parent": null,',
                '    "progress": {',
                '      "total": 2,',
                '      "done": 1,',
                '      "more": false',
                '    },',
                '    "updatedAt": "2026-09-30T10:00:00.000Z",',
                '    "description": "Users cannot sign in.",',
                '    "children": [],',
                '    "childrenMore": false',
                '  },',
                '  "comments": [',
                '    {',
                '      "id": "comment-1",',
                '      "body": "Still broken",',
                '      "createdAt": "2026-09-30T11:00:00.000Z",',
                '      "author": {',
                '        "name": "Bob B",',
                '        "avatarUrl": null',
                '      }',
                '    }',
                '  ]',
                '}',
            ].join('\n'),
            author: { login: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' },
        });
    });
});

describe('Linear filter menu order', () => {
    test('state filters come from the descriptor in its order; people and priority keep theirs', () => {
        expect(linearLikeTrackerDescriptor().stateFilters).toEqual(['open', 'all', 'backlog', 'todo', 'in-progress', 'inReview', 'done', 'canceled', 'duplicate']);
        expect([...TRACKER_PEOPLE_FILTERS]).toEqual(['any', 'me', 'created']);
        expect([...TRACKER_PRIORITY_FILTERS]).toEqual(['all', 'urgent', 'high', 'medium', 'low', 'none']);
    });
});
