import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { TrackerItemSummary } from '@/lib/trackers/types';
import { TrackerItemMeta } from './TrackerItemMeta';

const issue: TrackerItemSummary = {
    provider: 'acme-tickets',
    id: 'ACME-1',
    identifier: 'ACME-1',
    title: 'Plan the sprint',
    url: 'https://tickets.example.com/t/ACME-1',
    state: { id: 's-1', name: 'Open', category: 'todo' },
    priority: 'high',
    container: { id: 'p-1', key: 'ACME', name: 'Acme' },
    fields: [
        { id: 'customfield_10016', label: 'Story points', value: '5' },
        { id: 'duedate', label: 'Due date', value: '2026-12-01' },
    ],
};

const renderMeta = (capabilities: { priority: boolean; fields: boolean }, item: TrackerItemSummary = issue) => renderToStaticMarkup(
    <I18nProvider>
        <TrackerItemMeta
            issue={item}
            parent={null}
            assignee={null}
            updated={null}
            labels={[]}
            capabilities={capabilities}
        />
    </I18nProvider>,
);

const rows = (markup: string) => [...markup.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((match) => [match[1], match[2]]);

describe('tracker item meta fields', () => {
    test('draws each provider field as a label and value row when the capability is on', () => {
        expect(rows(renderMeta({ priority: true, fields: true }))).toEqual([
            ['Group', 'Acme'],
            ['Priority', 'High'],
            ['Story points', '5'],
            ['Due date', '2026-12-01'],
        ]);
    });

    test('draws no fields when the capability is off or the item has none', () => {
        expect(rows(renderMeta({ priority: true, fields: false })).map(([label]) => label)).toEqual(['Group', 'Priority']);
        expect(rows(renderMeta({ priority: true, fields: true }, { ...issue, fields: undefined })).map(([label]) => label)).toEqual(['Group', 'Priority']);
        expect(rows(renderMeta({ priority: true, fields: true }, { ...issue, fields: [] })).map(([label]) => label)).toEqual(['Group', 'Priority']);
    });
});
