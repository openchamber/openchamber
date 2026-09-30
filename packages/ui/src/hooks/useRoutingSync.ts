/**
 * Keeps the routing store current: one read of `/api/routing` per runtime, then
 * the control-stream events. Also where the safety net talks to the user
 * outside a permission card: a held request raises the toast an `ask`
 * session's would have, and when Jev could not be reached the request waits
 * too and a toast says so with the actual error.
 */
import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { usePermissionReviewStore } from '@/stores/usePermissionReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { notifyHeldPermission } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const useRoutingSync = (): void => {
  const available = useUIStore((state) => state.routingFeatureAvailable);
  const { t } = useI18n();
  const tRef = React.useRef(t);
  tRef.current = t;

  React.useEffect(() => {
    if (!available) return;
    const review = usePermissionReviewStore.getState();
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'permission-review-updated') review.applySnapshot(event.review);
      else if (event.type === 'event-stream-ready') {
        review.connect();
        void review.load({ refresh: true });
      } else if (event.type === 'event-stream-disconnected') review.disconnect();
    });
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      review.reset();
      void review.load();
    });
    void review.load();
    return () => {
      unsubscribeEvents();
      unsubscribeRuntime();
      review.reset();
    };
  }, [available]);

  React.useEffect(() => {
    if (!available) return;
    const { load, resetForRuntime } = useRoutingStore.getState();
    void load();
    return subscribeRuntimeEndpointChanged(() => {
      resetForRuntime();
      void load();
    });
  }, [available]);

  React.useEffect(() => {
    if (!available) return;
    return subscribeOpenchamberEvents((event) => {
      const store = useRoutingStore.getState();
      if (event.type === 'routing-updated') {
        store.applyAvailability(event);
      } else if (event.type === 'routing-decision') {
        store.recordDecision(event.decision);
      } else if (event.type === 'routing-permission-held') {
        store.holdPermission({ permissionId: event.permissionId, score: event.score, kind: event.kind });
        notifyHeldPermission(event.permissionId, event.sessionId, event.directory);
      } else if (event.type === 'routing-safety-skipped') {
        const runtimeKey = getRuntimeKey();
        toast.warning(tRef.current('routing.toast.safetySkipped'), {
          description: event.error,
          action: {
            label: tRef.current('chat.toast.opencodeRestartInterrupted.openSession'),
            onClick: () => {
              if (getRuntimeKey() !== runtimeKey) return;
              useSessionUIStore.getState().setCurrentSession(event.sessionId, event.directory);
            },
          },
        });
        notifyHeldPermission(event.permissionId, event.sessionId, event.directory);
      }
    });
  }, [available]);
};
