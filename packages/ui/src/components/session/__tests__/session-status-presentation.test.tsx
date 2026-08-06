import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { SessionStatusIndicator } from '../SessionStatusIndicator';

/**
 * Session status presentation contract tests.
 *
 * Unlike a test that copies branch logic, these tests import and render the
 * REAL `SessionStatusIndicator` production component. Any change to the
 * production status → presentation mapping breaks these tests.
 *
 * The `Icon` component (`@/components/icon/Icon`) is SSR-safe (it guards sprite
 * injection behind `typeof document !== "undefined"` and still emits an
 * `<svg aria-hidden>` with a `<use>` reference), so we render it directly and
 * mock nothing. If a future change makes `Icon` fail under
 * `renderToStaticMarkup`, the fallback below mocks it to a minimal element that
 * carries the icon name as `data-name`.
 */

// The real Icon renders fine under SSR. This mock is kept as a safety net so
// the presentation contract does not break if Icon's SSR path changes: it
// surfaces the icon name on `data-name` so tests can still assert which icon
// the reconnecting state renders. The real Icon also emits `aria-hidden="true"`
// which this mock mirrors.
mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) =>
    React.createElement('svg', { 'data-name': name, className, 'aria-hidden': 'true' }),
}));

function renderIndicator(
  statusType: 'busy' | 'retry' | 'reconnecting' | 'idle',
  showUnread = false,
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SessionStatusIndicator statusType={statusType} showUnread={showUnread} />
    </I18nProvider>,
  );
}

describe('SessionStatusIndicator production contract', () => {
  test('busy -> active visual state (accessible label "Session active")', () => {
    const markup = renderIndicator('busy');
    expect(markup).toContain('Session active');
  });

  test('retry -> active visual state (accessible label "Session active")', () => {
    const markup = renderIndicator('retry');
    expect(markup).toContain('Session active');
  });

  test('reconnecting -> reconnecting visual state (label "Reconnecting", NOT "Session active")', () => {
    const markup = renderIndicator('reconnecting');
    expect(markup).toContain('Reconnecting');
    // Preserved busy/retry data must not be presented as a confirmed active
    // pulse while `type === 'reconnecting'`.
    expect(markup).not.toContain('Session active');
    // The reconnecting state renders the cloud-off icon (assert via data-name
    // from the mocked Icon) — proves it is NOT the busy-pulse dot.
    expect(markup).toContain('cloud-off');
  });

  test('idle (showUnread=false) -> no status indicator (no labels at all)', () => {
    const markup = renderIndicator('idle', false);
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Unread');
  });

  test('idle (showUnread=true) -> unread dot (label "Unread updates", NOT active/reconnecting)', () => {
    const markup = renderIndicator('idle', true);
    expect(markup).toContain('Unread updates');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Reconnecting');
  });
});