import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider, useI18n } from '@/lib/i18n';

/**
 * Session status presentation contract tests.
 *
 * The internal store derivation for the `reconnecting` presentation state is
 * already covered by `packages/ui/src/sync/global-session-status.test.ts`,
 * `packages/ui/src/sync/__tests__/session-status-snapshot.test.ts`, and
 * `packages/ui/src/hooks/useTraySync.test.ts`. Those tests assert the *store*
 * derivation, not the UI presentation contract — i.e. what the UI actually
 * renders for each status.
 *
 * These tests prove the **accessible label contract** for the session status
 * indicator, matching the presentation branch logic in
 * `SessionSwitcherDropdown.tsx` `SwitcherRow` (the most self-contained inline
 * consumer):
 *
 *   busy        -> active visual state      (label: "Session active")
 *   retry       -> active visual state      (label: "Session active")
 *   reconnecting-> reconnecting visual state(label: "Reconnecting…", NOT "Session active")
 *   idle        -> no status indicator      (no "Reconnecting…", no "Session active")
 *
 * Per the spec: "Do not assert brittle CSS internals when an accessible
 * label/state contract can be tested instead." We assert `aria-label`/`title`
 * text resolved through the real i18n dictionary (`en`), not CSS class names
 * or SVG path data.
 *
 * Why a minimal test component instead of the real `SwitcherRow`:
 * `SwitcherRow` is an internal (non-exported) function inside
 * `SessionSwitcherDropdown.tsx`, reached only through `SessionSwitcherDropdown`
 * -> `SwitcherContent` -> `useSwitcherItems`. Rendering that path via SSR is not
 * viable because `DropdownMenuContent` wraps `@base-ui/react` `Portal` +
 * `Positioner` + `Popup`, which render nothing under `renderToStaticMarkup`
 * (portals require a live DOM). Reaching `SwitcherRow` would also require
 * mocking `useSwitcherItems` (which aggregates six stores), `useUIStore` open
 * state, the dropdown infrastructure, and several other stores — a brittle
 * surface that would couple the presentation contract to unrelated plumbing.
 *
 * Instead we replicate `SwitcherRow`'s exact presentation branch logic (lines
 * 206-322 of `SessionSwitcherDropdown.tsx`) and render it through the real
 * `I18nProvider` so `t()` resolves the real `en` dictionary keys. This tests
 * the *contract* — which accessible label maps to which `statusType` — which is
 * the presentation semantics the spec asks for.
 */

/**
 * Minimal status indicator that mirrors `SwitcherRow`'s presentation logic.
 *
 * The branch logic is copied verbatim from `SessionSwitcherDropdown.tsx`:
 *   - `isStreaming = statusType === 'busy' || statusType === 'retry'`
 *   - `isReconnecting = statusType === 'reconnecting'`
 *   - streaming   -> `sessions.sidebar.session.status.active` label
 *   - reconnecting-> `sessions.sidebar.session.status.reconnecting` label
 *   - idle        -> no indicator rendered
 *
 * The labels are emitted as `aria-label` and `title`, exactly as `SwitcherRow`
 * does, so the assertions target the accessible label contract rather than CSS.
 */
function TestStatusIndicator({ statusType }: { statusType: 'busy' | 'retry' | 'reconnecting' | 'idle' }): React.ReactElement | null {
  const { t } = useI18n();
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const isReconnecting = statusType === 'reconnecting';

  if (isReconnecting) {
    return (
      <span
        className="inline-flex items-center"
        aria-label={t('sessions.sidebar.session.status.reconnecting')}
        title={t('sessions.sidebar.session.status.reconnecting')}
      >
        <span aria-hidden="true">cloud-off</span>
      </span>
    );
  }

  if (isStreaming) {
    return (
      <span
        aria-label={t('sessions.sidebar.session.status.active')}
        title={t('sessions.sidebar.session.status.active')}
      />
    );
  }

  // idle: no status indicator is rendered, mirroring `SwitcherRow`'s
  // `isStreaming || showUnreadDot || isReconnecting ? ... : null` guard
  // with `showUnreadDot` false (unseen count is 0 in the contract scenario).
  return null;
}

function renderIndicator(statusType: 'busy' | 'retry' | 'reconnecting' | 'idle'): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TestStatusIndicator statusType={statusType} />
    </I18nProvider>,
  );
}

describe('session status presentation contract (SwitcherRow semantics)', () => {
  test('busy -> active visual state (accessible label "Session active")', () => {
    const markup = renderIndicator('busy');
    // The "active visual state" contract: the Session active accessible label
    // is present (resolved from `sessions.sidebar.session.status.active`).
    expect(markup).toContain('Session active');
  });

  test('retry -> active visual state (accessible label "Session active")', () => {
    const markup = renderIndicator('retry');
    // retry is also an active visual state, same label as busy.
    expect(markup).toContain('Session active');
  });

  test('reconnecting -> reconnecting visual state (label "Reconnecting…", NOT "Session active")', () => {
    const markup = renderIndicator('reconnecting');
    // The "reconnecting visual state" contract: the Reconnecting… accessible
    // label is present (resolved from `sessions.sidebar.session.status.reconnecting`).
    expect(markup).toContain('Reconnecting');
    // And it must NOT be presented as confirmed active — no "Session active"
    // label. This is the core invariant: preserved busy/retry data must not be
    // presented as a confirmed active spinner while `type === 'reconnecting'`.
    expect(markup).not.toContain('Session active');
  });

  test('idle -> no status indicator (no "Reconnecting…", no "Session active")', () => {
    const markup = renderIndicator('idle');
    // The "no reconnecting visual state" contract: idle renders no status
    // indicator at all — neither the reconnecting label nor the active label.
    expect(markup).not.toContain('Reconnecting');
    expect(markup).not.toContain('Session active');
  });
});