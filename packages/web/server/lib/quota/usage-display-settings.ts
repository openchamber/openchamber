export type UsageDisplaySettings = {
  usageDisplayMode?: 'usage' | 'remaining';
  usageResetDisplay?: 'absolute' | 'relative';
};

type UsageDisplayCandidate = {
  usageDisplayMode?: unknown;
  usageResetDisplay?: unknown;
};

export const sanitizeUsageDisplaySettings = (candidate: UsageDisplayCandidate): UsageDisplaySettings => {
  const settings: UsageDisplaySettings = {};
  if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
    settings.usageDisplayMode = candidate.usageDisplayMode;
  }
  if (candidate.usageResetDisplay === 'absolute' || candidate.usageResetDisplay === 'relative') {
    settings.usageResetDisplay = candidate.usageResetDisplay;
  }
  return settings;
};
