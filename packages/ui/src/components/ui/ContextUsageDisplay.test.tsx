import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatMessage, I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as ptBRDictionary } from '@/lib/i18n/messages/pt-BR';
import { ContextUsageDisplay } from './ContextUsageDisplay';
import { formatContextUsageValues } from './contextUsageFormat';

describe('ContextUsageDisplay accessibility', () => {
  test('renders static desktop usage as a focusable progressbar', () => {
    useI18nStore.getState().setLocale('en');
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageDisplay
          totalTokens={32_200}
          percentage={3.1}
          contextLimit={1_000_000}
          outputLimit={32_000}
          hideIcon
          showPercentIcon
          showTokenCount
          staticProgressbar
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain('<button');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-focus-ring="accent"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Context usage"');
    expect(markup).toContain('aria-valuetext="32.2K, 3.1% of context used"');
    expect(markup).toContain('32.2K (3.1%)');
    expect(markup).toContain('aria-hidden="true"');
  });

  test('keeps the clickable variant a real button without a nested progressbar', () => {
    useI18nStore.getState().setLocale('en');
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageDisplay
          totalTokens={32_200}
          percentage={3.1}
          contextLimit={1_000_000}
          hideIcon
          showPercentIcon
          showTokenCount
          staticProgressbar
          onClick={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="32.2K, 3.1% of context used"');
    expect(markup).not.toContain('role="progressbar"');
  });

  test('names the non-interactive desktop variant', () => {
    useI18nStore.getState().setLocale('en');
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageDisplay
          totalTokens={32_200}
          percentage={3.1}
          contextLimit={1_000_000}
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain('<button');
    expect(markup).toContain('aria-label="Context usage"');
    expect(markup).not.toContain('aria-valuetext');
  });

  test('names the non-interactive mobile variant', () => {
    useI18nStore.getState().setLocale('en');
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageDisplay
          totalTokens={32_200}
          percentage={3.1}
          contextLimit={1_000_000}
          isMobile
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain('<button');
    expect(markup).toContain('aria-label="Context usage"');
    expect(markup).not.toContain('aria-valuetext');
  });

  test('localizes compact numbers and the complete accessible value', () => {
    const values = formatContextUsageValues(32_200, 3.1, 'pt-BR');
    const accessibleValue = formatMessage(ptBRDictionary, 'contextUsage.aria.value', values);

    expect(values.tokens.replaceAll('\u00a0', ' ')).toBe('32,2 mil');
    expect(values.percentage).toBe('3,1%');
    expect(accessibleValue.replaceAll('\u00a0', ' ')).toBe('32,2 mil, 3,1% do contexto usado');
  });
});
