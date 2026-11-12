/**
 * Tells the user when a usage limit made the server switch something for them.
 *
 * The switch itself happens in the managed OpenCode (`lib/limit-failover` on
 * the server). An account switch changes the provider for every session, and
 * a model switch changes what the session's composer shows, so neither should
 * happen without a word.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useConfigStore } from '@/stores/useConfigStore';

export const useLimitFailoverNotices = (): void => {
  const { t } = useI18n();

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'limit-failover') return;
    const { failover } = event;
    // Read at event time: the catalog may have loaded since the hook mounted.
    const providers = useConfigStore.getState().providers;
    const provider = (id: string) => providers.find((candidate) => candidate.id === id);
    if (failover.kind === 'account') {
      const providerName = provider(failover.providerId)?.name || failover.providerId;
      toast.info(failover.fromAccount
        ? t('chat.limitFailover.toast.account', { provider: providerName, from: failover.fromAccount, to: failover.toAccount })
        : t('chat.limitFailover.toast.accountUnknown', { provider: providerName, to: failover.toAccount }));
      return;
    }
    toast.info(t('chat.limitFailover.toast.model', {
      model: getProviderModelDisplayName(provider(failover.providerId), failover.modelId),
      fallback: getProviderModelDisplayName(provider(failover.toProviderId), failover.toModelId),
    }));
  }), [t]);
};
