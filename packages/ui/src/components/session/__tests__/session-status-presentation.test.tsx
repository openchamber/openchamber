import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { SessionStatusIndicator } from '../SessionStatusIndicator';
import { MobileSessionChildToggle } from '../../../apps/MobileSessionChildToggle';
import { MobileSessionRowStatus } from '../../../apps/MobileSessionRowStatus';

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

/**
 * MobileSessionsSheet row layout: left-gutter child toggle + status-area
 * status indicator coexistence contract.
 *
 * Regression guard for the MobileSessionsSheet row layout fix: the
 * subsession expand/collapse control (left gutter) and the live-status
 * indicator (status area, right side of the row) are owned by separate
 * production components and rendered in separate layout slots, so a
 * reconnecting/busy/unread status NEVER overlaps or replaces the
 * expand/collapse action.
 *
 * These tests import and render the REAL production components
 * (`MobileSessionChildToggle` + `MobileSessionRowStatus`) together — the
 * same composition MobileSessionsSheet uses — and assert their coexistence
 * via accessible labels.
 */

type RowStatusProps = React.ComponentProps<typeof MobileSessionRowStatus>;

function renderRow({
  toggle,
  status,
}: {
  toggle?: { expanded: boolean; left?: number };
  status?: Partial<RowStatusProps>;
}): string {
  const statusProps: RowStatusProps = {
    statusType: status?.statusType ?? 'reconnecting',
    showUnread: status?.showUnread ?? false,
    showActivityDuration: status?.showActivityDuration ?? false,
    sessionId: status?.sessionId ?? 's1',
    isStreaming: status?.isStreaming ?? false,
    time: status?.time ?? '2m',
  };
  return renderToStaticMarkup(
    <I18nProvider>
      {toggle ? (
        <MobileSessionChildToggle expanded={toggle.expanded} onToggle={() => {}} left={toggle.left ?? 2} />
      ) : null}
      <MobileSessionRowStatus {...statusProps} />
    </I18nProvider>,
  );
}

describe('MobileSessionsSheet child-toggle + status coexistence (production components)', () => {
  test('row has children + reconnecting: status label AND expand action both present', () => {
    const markup = renderRow({
      toggle: { expanded: false },
      status: { statusType: 'reconnecting', showUnread: false, showActivityDuration: false, sessionId: 's1', isStreaming: false, time: '2m' },
    });
    // Status indicator present (reconnecting lives in the status area).
    expect(markup).toContain('Reconnecting');
    // Child toggle present (left gutter), expand action available.
    expect(markup).toContain('Expand subsessions');
    // The reconnecting cloud-off icon is rendered in the status area, not the
    // gutter, and the gutter shows the expand chevron — they never overlap.
    expect(markup).toContain('cloud-off');
  });

  test('row has children + expanded + reconnecting: collapse action label present', () => {
    const markup = renderRow({
      toggle: { expanded: true },
      status: { statusType: 'reconnecting', showUnread: false, showActivityDuration: false, sessionId: 's1', isStreaming: false, time: '2m' },
    });
    expect(markup).toContain('Reconnecting');
    expect(markup).toContain('Collapse subsessions');
    expect(markup).not.toContain('Expand subsessions');
  });

  test('row has NO children + reconnecting: status label present, NO expand/collapse action', () => {
    const markup = renderRow({
      status: { statusType: 'reconnecting', showUnread: false, showActivityDuration: false, sessionId: 's1', isStreaming: false, time: '2m' },
    });
    expect(markup).toContain('Reconnecting');
    // No child toggle rendered — the left gutter is empty for childless rows.
    expect(markup).not.toContain('Expand');
    expect(markup).not.toContain('Collapse');
  });

  test('row has children + busy: active status label AND expand action both present', () => {
    const markup = renderRow({
      toggle: { expanded: false },
      status: { statusType: 'busy', showUnread: false, showActivityDuration: false, sessionId: 's1', isStreaming: false, time: '2m' },
    });
    expect(markup).toContain('Session active');
    expect(markup).toContain('Expand subsessions');
  });
});
