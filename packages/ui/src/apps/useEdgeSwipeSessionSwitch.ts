import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Native-feeling edge swipe to switch sessions in the mobile chat: start a horizontal swipe
 * from the very left/right edge and drag toward the centre to step through sessions.
 *
 * - Left edge → centre  = previous session (the more-recent one in the list)
 * - Right edge → centre = next session (the older one)
 *
 * Navigation walks the same ranked list the rest of the mobile UI uses: top-level sessions
 * (no subtasks) across all projects, lifecycle-ranked with timestamp fallback. The order is computed at
 * gesture time from the store (not subscribed) so it's always fresh and never re-attaches.
 *
 * Only `touchstart`/`touchend` are observed (both passive), so this never interferes with
 * vertical chat scrolling or the horizontal scroll inside code blocks — it just reads where the
 * gesture began and ended. The edge zone keeps it clear of in-content horizontal scroll, which
 * lives away from the screen edges.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
const MIN_DISTANCE = 64; // px of horizontal travel required to commit a switch
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)

const parentIdOf = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

/** Top-level sessions across all projects in shared display order. */
const orderedTopLevelSessions = (): Session[] => {
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;
  const sessionOrderRanks = useSessionOrderingStore.getState().rankById;
  return useGlobalSessionsStore
    .getState()
    .activeSessions.filter((session) => parentIdOf(session) === null)
    .slice()
    .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks));
};

/**
 * Switch to the session `step` positions away from the current one (clamped — no wrap).
 * Returns true if a switch actually happened.
 */
const switchByStep = (step: number): boolean => {
  const ordered = orderedTopLevelSessions();
  if (ordered.length < 2) return false;

  const currentId = useSessionUIStore.getState().currentSessionId;
  const index = ordered.findIndex((session) => session.id === currentId);
  if (index < 0) return false;

  const targetIndex = index + step;
  if (targetIndex < 0 || targetIndex >= ordered.length) return false;

  const target = ordered[targetIndex];
  useSessionUIStore.getState().setCurrentSession(target.id, resolveGlobalSessionDirectory(target));
  return true;
};

export interface EdgeSwipeSessionSwitchOptions {
  /** Called after a successful switch, with the travel direction, so the caller can animate. */
  onSwitch?: (direction: 'prev' | 'next') => void;
}

export const useEdgeSwipeSessionSwitch = (
  ref: React.RefObject<HTMLElement | null>,
  options?: EdgeSwipeSessionSwitchOptions,
): void => {
  // Keep onSwitch in a ref so a changing callback identity doesn't re-attach the listeners.
  const onSwitchRef = React.useRef(options?.onSwitch);
  onSwitchRef.current = options?.onSwitch;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let tracking = false;
    let fromLeftEdge = false;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= EDGE_ZONE;
      const nearRight = touch.clientX >= width - EDGE_ZONE;
      tracking = nearLeft || nearRight;
      fromLeftEdge = nearLeft;
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < MIN_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS_RATIO) return;
      // Must travel toward the centre: left edge → rightward, right edge → leftward.
      if (fromLeftEdge && dx <= 0) return;
      if (!fromLeftEdge && dx >= 0) return;

      const step = fromLeftEdge ? -1 : 1;
      if (switchByStep(step)) {
        onSwitchRef.current?.(step < 0 ? 'prev' : 'next');
      }
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref]);
};
