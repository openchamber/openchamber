import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as pl } from '@/lib/i18n/messages/pl';
import { dict as uk } from '@/lib/i18n/messages/uk';
import { I18nContext } from '@/lib/i18n/react-context';
import { formatMessage, type I18nDictionary } from '@/lib/i18n/store';
import { LOCALES, type Locale } from '@/lib/i18n/runtime';
import type { ContextToolChildRow, ContextToolCounts } from './toolSegmentProjection';
import { ContextToolGroupRow } from './ContextToolGroupRow';

const OUTPUT_SENTINEL = 'SECRET CONTEXT TOOL OUTPUT';

const makeChild = (
    id: string,
    kind: ContextToolChildRow['kind'],
    state: ContextToolChildRow['state'],
    hint: string,
): ContextToolChildRow => ({
    id,
    kind,
    state,
    hint,
});

const children = [
    makeChild('read-1', 'read', 'done', 'first-file.ts'),
    makeChild('grep-1', 'search', 'active', 'second-pattern'),
];

const LocaleMarkupProvider: React.FC<{
    locale: Locale;
    dictionary: I18nDictionary;
    children: React.ReactNode;
}> = ({ locale, dictionary, children: content }) => (
    <I18nProvider>
        <I18nContext.Provider value={{
            locale,
            locales: LOCALES,
            setLocale: () => {},
            label: () => '',
            t: (key, params) => formatMessage(dictionary, key, params),
        }}>
            {content}
        </I18nContext.Provider>
    </I18nProvider>
);

const renderRow = (options: {
    locale?: 'en' | 'pl' | 'uk';
    isExpanded?: boolean;
    status?: 'active' | 'error' | 'done';
    counts?: ContextToolCounts;
    rows?: ContextToolChildRow[];
} = {}) => {
    const locale = options.locale ?? 'en';
    const dictionary = locale === 'pl' ? pl : locale === 'uk' ? uk : en;

    return renderToStaticMarkup(
        <LocaleMarkupProvider locale={locale} dictionary={dictionary}>
            <ContextToolGroupRow
                rowKey="context-tool-group:read-1"
                status={options.status ?? 'done'}
                counts={options.counts ?? { read: 1, search: 1, list: 0 }}
                children={options.rows ?? children}
                renderSignature="test-row"
                animateTailText={false}
                isExpanded={options.isExpanded ?? false}
                onToggleTool={() => {}}
            />
        </LocaleMarkupProvider>,
    );
};

const getContextToolTriggerTag = (markup: string): string => {
    const match = markup.match(/<button\b(?=[^>]*aria-label="(?:Expand|Collapse) context tool details:)[^>]*>/);
    if (!match) {
        throw new Error('Context tool disclosure trigger was not rendered');
    }
    return match[0];
};

describe('ContextToolGroupRow', () => {
    test('renders a controlled collapsed trigger without child details or output', () => {
        const markup = renderRow();

        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-label="Expand context tool details: Explored 1 read 1 search"');
        expect(markup).toContain('title="Expand context tool details: Explored 1 read 1 search"');
        expect(markup).toContain('Explored');
        expect(markup).toContain('1 read · 1 search');
        expect(markup).not.toContain('first-file.ts');
        expect(markup).not.toContain('second-pattern');
        expect(markup).not.toContain(OUTPUT_SENTINEL);
    });

    test('keeps the disclosure header background transparent on hover', () => {
        for (const isExpanded of [false, true]) {
            const markup = renderRow({ isExpanded });
            const triggerTag = getContextToolTriggerTag(markup);

            expect(triggerTag).toContain(`aria-expanded="${isExpanded}"`);
            expect(triggerTag).toContain('style="background-color:transparent"');
            expect(triggerTag).toContain('hover:bg-transparent');
            expect(triggerTag).not.toContain('hover:bg-interactive-hover');
        }
    });

    test('renders controlled expanded details in projected source order without output', () => {
        const markup = renderRow({ isExpanded: true });

        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('aria-label="Collapse context tool details: Explored 1 read 1 search"');
        expect(markup).toContain('title="Collapse context tool details: Explored 1 read 1 search"');
        expect(markup).toContain('Read');
        expect(markup).toContain('Search');
        expect(markup).toContain('Active');
        expect(markup.indexOf('first-file.ts')).toBeLessThan(markup.indexOf('second-pattern'));
        expect(markup).not.toContain(OUTPUT_SENTINEL);
    });

    test('renders the failed header title over active child state', () => {
        const markup = renderRow({ status: 'error' });

        expect(markup).toContain('Exploration failed');
        expect(markup).not.toContain('Exploring');
        expect(markup).not.toContain('second-pattern');
    });

    test('uses locale-correct Polish and Ukrainian count forms', () => {
        const counts = (read: number): ContextToolCounts => ({ read, search: 0, list: 0 });

        expect(renderRow({ locale: 'pl', counts: counts(1) })).toContain('1 odczyt');
        expect(renderRow({ locale: 'pl', counts: counts(2) })).toContain('2 odczyty');
        expect(renderRow({ locale: 'pl', counts: counts(5) })).toContain('5 odczytów');
        expect(renderRow({ locale: 'uk', counts: counts(1) })).toContain('1 читання');
        expect(renderRow({ locale: 'uk', counts: counts(2) })).toContain('2 читання');
        expect(renderRow({ locale: 'uk', counts: counts(5) })).toContain('5 читань');
        expect(renderRow({ locale: 'uk', counts: counts(21) })).toContain('21 читання');
        expect(renderRow({ locale: 'pl', counts: counts(21) })).toContain('21 odczytów');
    });

    test('includes localized status and counts in a non-English trigger name', () => {
        const markup = renderRow({ locale: 'pl' });

        expect(markup).toContain('aria-label="Rozwiń szczegóły narzędzi kontekstowych: Eksploracja zakończona 1 odczyt 1 wyszukiwanie"');
        expect(markup).toContain('title="Rozwiń szczegóły narzędzi kontekstowych: Eksploracja zakończona 1 odczyt 1 wyszukiwanie"');
    });
});
