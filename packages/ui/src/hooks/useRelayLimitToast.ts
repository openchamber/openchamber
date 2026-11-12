import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getActiveRelayTunnel, subscribeActiveRelayTunnelStatus } from '@/lib/relay/runtime-tunnel';
import { isRelayLimitReached } from '@/lib/relay/tunnel-client';

const RELAY_LIMIT_TOAST_ID = 'relay-limit-reached';

/**
 * Says so when the relay refuses this window's runtime tunnel over its limits
 * (too many devices at once, too many connects a minute). The tunnel then
 * parks until the next `online` event or return to the foreground, and a
 * desktop window that stays on screen gets neither, so the toast carries the
 * retry. It closes once the tunnel connects again or the window leaves the
 * relay.
 */
export const useRelayLimitToast = (): void => {
  const { t } = useI18n();

  React.useEffect(() => {
    const show = () => {
      toast.error(t('relayConnection.limitReached.title'), {
        id: RELAY_LIMIT_TOAST_ID,
        description: t('relayConnection.limitReached.description'),
        duration: Infinity,
        action: {
          label: t('relayConnection.limitReached.retry'),
          onClick: () => getActiveRelayTunnel()?.retry(),
        },
      });
    };
    if (isRelayLimitReached(getActiveRelayTunnel()?.getStatus())) show();
    const unsubscribe = subscribeActiveRelayTunnelStatus((status) => {
      if (isRelayLimitReached(status)) show();
      else if (status.state === 'connected' || status.state === 'idle') toast.dismiss(RELAY_LIMIT_TOAST_ID);
    });
    return unsubscribe;
  }, [t]);
};
