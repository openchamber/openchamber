import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { ComposerStopButton } from './ComposerStopButton';

describe('ComposerStopButton', () => {
    test('renders an accessible semantic stop action with a mobile touch target', () => {
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ComposerStopButton
                    buttonClassName="min-h-[44px] min-w-[44px]"
                    iconClassName="h-6 w-6"
                    onStop={() => {}}
                />
            </I18nProvider>,
        );

        expect(markup).toContain('type="button"');
        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('min-h-[44px] min-w-[44px]');
        expect(markup).toContain('text-[var(--status-error)]');
        expect(markup).toContain('focus-visible:ring-[3px]');
        expect(markup).toContain('aria-hidden="true"');
    });
});
