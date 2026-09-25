/**
 * Keeps the routing store current: one read of `/api/routing` per runtime, then
 * the control-stream events. Also the one place the safety net talks to the
 * user outside a permission card — when Jev could not be reached, auto-accept
 * went ahead as it always has, and a toast says so with the actual error.
 */
import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';

export const useRoutingSync = (): void => {
  const available = useUIStore((state) => state.routingFeatureAvailable);
  const { t } = useI18n();
  const tRef = React.useRef(t);
  tRef.current = t;

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
      } else if (event.type === 'routing-safety-skipped') {
        toast.warning(tRef.current('routing.toast.safetySkipped'), { description: event.error });
      }
    });
  }, [available]);
};
