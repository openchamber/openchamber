import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CollapsedActivityIndicator } from './collapsedActivityIndicator';

// The two states must differ in shape, not colour alone: a running turn spins,
// a finished-but-unread one is a static dot. A static marker for both is the
// regression reported in issue #2826.
describe('CollapsedActivityIndicator', () => {
  test('spins while a session below the collapsed row is running', () => {
    const markup = renderToStaticMarkup(
      <CollapsedActivityIndicator state="active" activeLabel="Session active" unreadLabel="Unread" />,
    );

    expect(markup).toContain('animate-spin');
    expect(markup).toContain('#oc-loader-4');
    expect(markup).toContain('aria-label="Session active"');
    expect(markup).not.toContain('rounded-full');
  });

  test('renders a static dot once the result is only unread', () => {
    const markup = renderToStaticMarkup(
      <CollapsedActivityIndicator state="unread" activeLabel="Session active" unreadLabel="Unread" />,
    );

    expect(markup).toContain('rounded-full');
    expect(markup).toContain('var(--status-info)');
    expect(markup).toContain('aria-label="Unread"');
    expect(markup).not.toContain('animate-spin');
  });
});
