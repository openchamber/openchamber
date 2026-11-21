import { describe, expect, test } from 'bun:test';

import { CONTEXT_METADATA_KEY, type ContextPartPayload } from '@/lib/messages/contextParts';
import type { Part } from '@/lib/opencode/model';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';

import { normalizeUserDisplayParts } from '../normalizeUserDisplayParts';
import { referenceLinkChipsOf } from './referenceLinkChips';

const urls = createRepositoryUrlMatcher([githubLikeDescriptor()], []);
const trackers = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);

// SAFETY: a synthetic context part as the composer builds it; normalization
// reads only its identity, type, text and metadata.
const contextPart = (id: string, payload: ContextPartPayload): Part => ({
    id,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'text',
    text: 'context',
    synthetic: true,
    metadata: { [CONTEXT_METADATA_KEY]: payload },
} as Part);

const ISSUE_URL = 'https://github.com/openchamber/openchamber/issues/6308';
const displayParts = normalizeUserDisplayParts([
    contextPart('prt_issue', { kind: 'repository-issue', provider: 'github', number: 6308, title: 'Let a project pick its model', url: ISSUE_URL }),
    contextPart('prt_pr', { kind: 'change-request', provider: 'github', number: 12, title: 'Fix login', url: 'https://github.com/openchamber/openchamber/pull/12' }),
    contextPart('prt_linear', { kind: 'tracker-item', provider: 'linear', identifier: 'OPE-282', title: 'Some title', url: 'https://linear.app/openchamber/issue/OPE-282/some-title' }),
], (id) => urls.descriptorOf(id ?? 'github'));

describe('referenceLinkChipsOf', () => {
    test('a link in the text that names a linked item draws as its chip, whatever page of the item it opens', () => {
        const text = `about ${ISSUE_URL}? and https://linear.app/openchamber/issue/ope-282 too, https://github.com/openchamber/openchamber/pull/12/files.`;
        const chips = referenceLinkChipsOf([text], displayParts, urls, trackers);
        expect([...chips.keys()]).toEqual([
            ISSUE_URL,
            'https://linear.app/openchamber/issue/ope-282',
            'https://github.com/openchamber/openchamber/pull/12/files',
        ]);
        expect(chips.get(ISSUE_URL)).toMatchObject({ chip: { label: '#6308 Let a project pick its model', icon: 'record-circle' }, url: ISSUE_URL });
        expect(chips.get(ISSUE_URL)?.part).toBe(displayParts[0]);
        expect(chips.get('https://github.com/openchamber/openchamber/pull/12/files')?.chip.icon).toBe('git-pull-request');
    });

    test('resolved source links draw each chip and open its canonical change request', () => {
        const links = ['https://portal.example/review/42', 'https://portal.example/changes/42', 'https://portal.example/review/77'];
        const canonical = ['https://github.com/acme/app/pull/42', 'https://github.com/acme/app/pull/77'];
        const parts = normalizeUserDisplayParts([
            contextPart('prt_42', { kind: 'change-request', provider: 'github', number: 42, title: 'First', url: canonical[0], sourceLinks: links.slice(0, 2) }),
            contextPart('prt_77', { kind: 'change-request', provider: 'github', number: 77, title: 'Second', url: canonical[1], sourceLinks: [links[2]] }),
        ], (id) => urls.descriptorOf(id ?? 'github'));
        const chips = referenceLinkChipsOf([links.join(' ')], parts, urls, trackers);
        expect([...chips.keys()]).toEqual(links);
        expect(links.map((link) => chips.get(link)?.url)).toEqual([canonical[0], canonical[0], canonical[1]]);
        expect(links.map((link) => chips.get(link)?.part)).toEqual([parts[0], parts[0], parts[1]]);
        expect(referenceLinkChipsOf([`\`${links[0]}\``], parts, urls, trackers).size).toBe(0);
    });

    test('an exact source link wins over a native template match', () => {
        const link = 'https://github.com/acme/app/pull/42';
        const canonical = 'https://github.com/acme/app/pull/77';
        const parts = normalizeUserDisplayParts([
            contextPart('native', { kind: 'change-request', provider: 'github', number: 42, title: 'Native', url: link }),
            contextPart('resolved', { kind: 'change-request', provider: 'github', number: 77, title: 'Resolved', url: canonical, sourceLinks: [link] }),
        ], (id) => urls.descriptorOf(id ?? 'github'));
        expect(referenceLinkChipsOf([link], parts, urls, trackers).get(link)).toMatchObject({ url: canonical, part: parts[1] });
    });

    test('an item the text does not link, or links only inside code, stays above the text', () => {
        const chips = referenceLinkChipsOf([`see \`${ISSUE_URL}\` and https://github.com/openchamber/openchamber/issues/7`], displayParts, urls, trackers);
        expect(chips.size).toBe(0);
        expect(referenceLinkChipsOf([`text\n\n    ${ISSUE_URL}`], displayParts, urls, trackers).size).toBe(0);
        expect(referenceLinkChipsOf([`text\n\`\`\`\n${ISSUE_URL}`], displayParts, urls, trackers).size).toBe(0);
    });

    test('emphasis around a link is not part of it, so Markdown finds the chip by its href', () => {
        expect([...referenceLinkChipsOf([`**${ISSUE_URL}**`], displayParts, urls, trackers).keys()]).toEqual([ISSUE_URL]);
    });
});
