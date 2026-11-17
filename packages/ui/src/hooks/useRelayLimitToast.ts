import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getActiveRelayTunnel, subscribeActiveRelayTunnelStatus } from '@/lib/relay/runtime-tunnel';
import { isRelayLimitReached } from '@/lib/relay/tunnel-client';

const RELAY_LIMIT_TOAST_ID = 'relay-limit-reached';

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
