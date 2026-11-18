
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

const isEnvironmentString = (value: unknown): value is string => typeof value === 'string';

export const isOverviewFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_OVERVIEW_ENABLED;
  return isEnvironmentString(raw) && TRUTHY.has(raw.trim().toLowerCase());
};
