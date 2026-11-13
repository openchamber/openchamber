import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
mock.module('../../useOpenChatLink', () => ({ useOpenChatLink: () => () => undefined }));

const { JsonSummaryView } = await import('./JsonSummaryView');

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

    test('previews values in collapsed objects while preserving their identity', () => {
        const html = renderToStaticMarkup(
            <JsonSummaryView
                data={{
                    outer: { result: {
                        id: 'model-1',
                        name: 'GPT-6.1',
                        model: 'GPT-6.1',
                        provider: 'OpenAI',
                        enabled: true,
                    } },
                }}
            />,
        );

        expect(html).toContain('Result · model-1 · GPT-6.1 · { model: &quot;GPT-6.1&quot;, provider: &quot;OpenAI&quot;, … }');
    });

    test('bounds long object previews', () => {
        const html = renderToStaticMarkup(
            <JsonSummaryView data={{ outer: { inner: { value: 'x'.repeat(120) } } }} />,
        );
        const preview = html.match(/Inner · \{ value: ([^<]+)<\/span>/)?.[1];

        expect(preview).toBeDefined();
        if (!preview) throw new Error('Expected a collapsed object preview');
        expect(preview.length).toBeLessThanOrEqual(96);
        expect(preview.endsWith('…')).toBe(true);
    });

    test('previews unnamed objects and leaves expanded headers unchanged', () => {
        const html = renderToStaticMarkup(
            <JsonSummaryView data={{ items: [{ model: 'GPT-6.1', provider: 'OpenAI' }, {}] }} />,
        );

        expect(html).toContain('{ model: &quot;GPT-6.1&quot;, provider: &quot;OpenAI&quot; }');
        expect(html).toContain('>{}</span>');

        const expanded = renderToStaticMarkup(<JsonSummaryView data={{ result: { model: 'GPT-6.1' } }} />);
        expect(expanded).not.toContain('Result · { model:');
    });

    test('distinguishes empty nested containers in previews', () => {
        const html = renderToStaticMarkup(<JsonSummaryView data={{ items: [{ errors: [], metadata: {} }] }} />);
        expect(html).toContain('{ errors: [], metadata: {} }');
    });

    test('turns only an open section’s chevron, nested ones included', () => {
        // A chevron that rotates whenever *any* enclosing section is open points
        // down on every nested row that is still collapsed. Direction belongs to
        // the row's own <details>, so a collapsed one stays pointing right.
        const html = renderToStaticMarkup(
            <JsonSummaryView data={{ outer: { inner: { deep: 'value' } } }} />,
        );

        const classes = [...html.matchAll(/class="([^"]*)"/g)]
            .flatMap((match) => match[1].split(/\s+/));
        // The outer section opens by default; the nested one does not.
        expect(classes.filter((name) => name === 'rotate-90')).toHaveLength(1);
        expect(html).not.toContain('group-open/json-summary');
    });
});
