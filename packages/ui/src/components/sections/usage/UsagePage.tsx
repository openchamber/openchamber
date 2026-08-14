import React from 'react';
import { USAGE_ADD_PROVIDER_ID, type UsageSelectionId } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';
import { UsageAddProvider } from './UsageAddProvider';
import { UsageOverview } from './UsageOverview';
import { UsageProviderDetail } from './UsageProviderDetail';

const isQuotaProviderId = (value: UsageSelectionId | null): value is QuotaProviderId =>
  value !== null && value !== USAGE_ADD_PROVIDER_ID;

export const UsagePage: React.FC = () => {
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);

  if (selectedProviderId === USAGE_ADD_PROVIDER_ID) {
    return <UsageAddProvider />;
  }

  if (isQuotaProviderId(selectedProviderId)) {
    return <UsageProviderDetail providerId={selectedProviderId} />;
  }

  return <UsageOverview />;
};
