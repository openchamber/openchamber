import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionActivityMarker } from './SessionActivityMarker';

const renderMarker = (state: 'active' | 'unread') => renderToStaticMarkup(
  <SessionActivityMarker state={state} label={state === 'active' ? 'Session active' : 'Unread'} />,
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(__dirname, '..', '..', '..', '..');

describe('SessionActivityMarker', () => {
  test('renders a static open ring for active sessions', () => {
    const markup = renderMarker('active');

    expect(markup).toContain('role="img"');
    expect(markup).toContain('size-2.5');
    expect(markup).toContain('border-2');
    expect(markup).toContain('border-primary');
    expect(markup).toContain('aria-label="Session active"');
    expect(markup).not.toContain('bg-primary');
    expect(markup).not.toContain('animate-');
  });

  test('renders a static filled dot for unread sessions', () => {
    const markup = renderMarker('unread');

    expect(markup).toContain('role="img"');
    expect(markup).toContain('size-1.5');
    expect(markup).toContain('var(--status-info)');
    expect(markup).toContain('aria-label="Unread"');
    expect(markup).not.toContain('border-2');
    expect(markup).not.toContain('animate-');
  });

  test('can stay decorative on mobile rows', () => {
    const markup = renderToStaticMarkup(
      <SessionActivityMarker state="active" label="Session active" decorative />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
    expect(markup).not.toContain('aria-label');
  });

  test('all session-list surfaces use the shared marker', () => {
    const files = [
      join(__dirname, 'SessionNodeItem.tsx'),
      join(__dirname, 'collapsedActivityIndicator.tsx'),
      join(uiSrc, 'apps', 'MobileSessionsSheet.tsx'),
      join(uiSrc, 'apps', 'MobileSessionSwitcher.tsx'),
    ];

    for (const file of files) {
      expect(readFileSync(file, 'utf8')).toContain('<SessionActivityMarker');
    }
  });
});
