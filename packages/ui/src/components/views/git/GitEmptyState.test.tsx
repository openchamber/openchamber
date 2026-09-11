import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { GitEmptyState } from './GitEmptyState';

describe('GitEmptyState', () => {
  test('fills and centers within the available pane height', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(GitEmptyState, { onOpenStashes: () => {} }),
      ),
    );

    expect(markup).toContain('class="flex h-full flex-1 flex-col items-center justify-center px-4 text-center"');
    expect(markup).not.toContain('py-10');
  });
});
