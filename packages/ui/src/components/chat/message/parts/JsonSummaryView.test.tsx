import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { JsonSummaryView } from './JsonSummaryView';

describe('JsonSummaryView', () => {
    test('prioritizes a record identity and makes URLs navigable', () => {
        const html = renderToStaticMarkup(
            <JsonSummaryView
                data={{
                    id: 'OPE-266',
                    title: 'Refresh git status',
                    url: 'https://linear.app/openchamber/issue/OPE-266',
                    relations: { blocks: [] },
                }}
            />,
        );

        expect(html).toContain('OPE-266 · Refresh git status');
        expect(html).toContain('href="https://linear.app/openchamber/issue/OPE-266"');
        expect(html).toContain('Relations');
        expect(html).not.toContain('surface-elevated');
    });

    test('summarizes record arrays as expandable sections', () => {
        const html = renderToStaticMarkup(
            <JsonSummaryView data={{ issues: [{ identifier: 'OPE-1', name: 'Example issue' }] }} />,
        );

        expect(html).toContain('Issues (1)');
        expect(html).toContain('OPE-1 · Example issue');
    });
});
