import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { RepositoryIssueReference, RepositoryReference } from '@/lib/api/types';

import { forgetLabelWrite, recordLabelWrite, reconcileLabelWrites, useLabelWrites, type LabelWrites } from './labelWrites';

const reference = (number: number, labels: string[]): RepositoryIssueReference => ({
    kind: 'issue',
    provider: 'gitea',
    number,
    title: `Issue ${number}`,
    url: `https://git.example.com/acme/app/issues/${number}`,
    body: '',
    bodyTruncated: false,
    createdAt: null,
    updatedAt: null,
    author: null,
    labels: labels.map((name) => ({ name })),
    commentCount: 0,
    state: 'open',
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
});

const keep = (item: RepositoryReference) => item;

/** The store as a list surface reads it. */
const readWrites = (): LabelWrites => {
    const browser = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true });
    let read: LabelWrites = new Map();
    const Probe = () => { read = useLabelWrites(); return null; };
    const root = createRoot(document.createElement('div'));
    act(() => { root.render(React.createElement(Probe)); });
    act(() => { root.unmount(); });
    return read;
};

describe('label writes over a list', () => {
    test('a later change made elsewhere shows once the hold ends', () => {
        const store = new Map([[
            'issue:https://git.example.com/acme/app/issues/7',
            { labels: [{ name: 'docs' }], at: 0, reference: reference(7, ['docs']), listing: { listKey: 'list', index: 0 } },
        ]]);
        const listed = [reference(7, ['bug'])];
        const options = { listKey: 'list', filterLabels: [], restore: keep };
        expect(reconcileLabelWrites(listed, store, { ...options, now: 60_000 })[0]?.labels).toEqual([{ name: 'docs' }]);
        expect(reconcileLabelWrites(listed, store, { ...options, now: 120_000 })).toBe(listed);
        // Dropped from its list after the hold, it stays dropped.
        expect(reconcileLabelWrites([], store, { ...options, now: 120_000 })).toEqual([]);
    });

    test('a drop from a list without a label filter stands, as after a close', () => {
        const store = new Map([[
            'issue:https://git.example.com/acme/app/issues/7',
            { labels: [{ name: 'docs' }], at: 0, reference: reference(7, ['docs']), listing: { listKey: 'list', index: 0 } },
        ]]);
        expect(reconcileLabelWrites([], store, { listKey: 'list', filterLabels: [], restore: keep, now: 1_000 })).toEqual([]);
    });

    test('a close or merge through the app ends the hold, so a filtered list drops the item', () => {
        const item = { ...reference(8, ['bug']), url: 'https://git.example.com/acme/app/issues/8-forget' };
        recordLabelWrite(item, [{ name: 'bug' }, { name: 'docs' }], { listKey: 'list', index: 0 }, Date.now());
        const options = { listKey: 'list', filterLabels: ['bug'], restore: keep, now: Date.now() + 1_000 };
        const before = readWrites();
        expect(reconcileLabelWrites([], before, options).map((entry) => entry.number)).toEqual([8]);
        forgetLabelWrite(item);
        const after = readWrites();
        expect(reconcileLabelWrites([], after, options)).toEqual([]);
    });
});
