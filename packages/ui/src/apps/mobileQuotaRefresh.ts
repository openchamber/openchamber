export const shouldRefreshQuotaOnMetadataOpen = ({
  open,
  wasOpen,
  isLoading,
  dropdownProviderIds,
  results,
  lastUpdated,
  refreshIntervalMs,
  now,
}: {
  open: boolean;
  wasOpen: boolean;
  isLoading: boolean;
  dropdownProviderIds: readonly string[];
  results: ReadonlyArray<{ providerId: string }>;
  lastUpdated: number | null;
  refreshIntervalMs: number;
  now: number;
}): boolean => {
  if (!open || wasOpen || isLoading) return false;
  if (dropdownProviderIds.some((providerId) => !results.some((result) => result.providerId === providerId))) {
    return true;
  }
  return lastUpdated === null || now - lastUpdated >= refreshIntervalMs;
};
