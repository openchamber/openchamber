import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { SessionStatusIndicator, type SessionDisplayStatusType } from '../SessionStatusIndicator';
import { MobileSessionRowStatus } from '../../../apps/MobileSessionRowStatus';

/**
 * Session status presentation contract tests.
 *
 * These render the REAL production components — no Icon mock: the shared
 * `Icon` is SSR-safe (it guards sprite injection behind `typeof document` and
 * still emits `<svg aria-hidden>` with a `<use href="#oc-…">` reference), so
 * the reconnecting state can be identified by its cloud-off reference. Any
 * change to the status → presentation mapping breaks these tests.
 */

function renderIndicator(statusType: SessionDisplayStatusType, showUnread = false): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SessionStatusIndicator statusType={statusType} showUnread={showUnread} />
    </I18nProvider>,
  );
}

type RowStatusProps = React.ComponentProps<typeof MobileSessionRowStatus>;

function renderMobileRowStatus(overrides: Partial<RowStatusProps> = {}): string {
  const props: RowStatusProps = {
    statusType: 'idle',
    showUnread: false,
    showActivityDuration: false,
    sessionId: 's1',
    isStreaming: false,
    time: '2m',
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <MobileSessionRowStatus {...props} />
    </I18nProvider>,
  );
}

describe('SessionStatusIndicator production contract', () => {
  test('busy -> animated active dot with label "Session active"', () => {
    const markup = renderIndicator('busy');
    expect(markup).toContain('Session active');
    expect(markup).toContain('animate-busy-pulse');
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('Unread updates');
  });

  test('retry -> animated active dot with label "Session active"', () => {
    const markup = renderIndicator('retry');
    expect(markup).toContain('Session active');
    expect(markup).toContain('animate-busy-pulse');
    expect(markup).not.toContain('Reconnecting');
  });

  test('reconnecting -> static cloud-off, label "Reconnecting", never active or busy', () => {
    const markup = renderIndicator('reconnecting');
    expect(markup).toContain('Reconnecting');
    // The reconnecting icon is the real sprite reference; no animation class.
    expect(markup).toContain('#oc-cloud-off');
    expect(markup).not.toContain('animate-busy-pulse');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Unread updates');
    // The label is exposed to assistive tech, not just painted.
    expect(markup).toContain('role="img"');
  });

  test('idle (no unread) -> no indicator at all', () => {
    const markup = renderIndicator('idle', false);
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('Unread updates');
  });

  test('idle (unread) -> static unread dot, never active or reconnecting', () => {
    const markup = renderIndicator('idle', true);
    expect(markup).toContain('Unread updates');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('animate-busy-pulse');
  });
});

describe('MobileSessionRowStatus production contract', () => {
  test('reconnecting row: reconnecting status label + timestamp, no expand/collapse action', () => {
    const markup = renderMobileRowStatus({ statusType: 'reconnecting' });
    expect(markup).toContain('Reconnecting');
    expect(markup).toContain('2m');
    // Status is never announced as the subsession toggle action.
    expect(markup).not.toContain('Expand subsessions');
    expect(markup).not.toContain('Collapse subsessions');
    expect(markup).not.toContain('Session active');
  });

  test('busy row: active status label, no expand/collapse action', () => {
    const markup = renderMobileRowStatus({ statusType: 'busy' });
    expect(markup).toContain('Session active');
    expect(markup).not.toContain('Expand subsessions');
    expect(markup).not.toContain('Collapse subsessions');
    expect(markup).not.toContain('Reconnecting');
  });

  test('idle row without unread: timestamp only, no status labels and no toggle labels', () => {
    const markup = renderMobileRowStatus({ statusType: 'idle', showUnread: false });
    expect(markup).toContain('2m');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('Unread updates');
    expect(markup).not.toContain('Expand subsessions');
    expect(markup).not.toContain('Collapse subsessions');
  });

  test('idle row with unread: unread label, never the toggle action', () => {
    const markup = renderMobileRowStatus({ statusType: 'idle', showUnread: true });
    expect(markup).toContain('Unread updates');
    expect(markup).not.toContain('Expand subsessions');
    expect(markup).not.toContain('Collapse subsessions');
    expect(markup).not.toContain('Session active');
    expect(markup).not.toContain('Reconnecting');
  });
});
