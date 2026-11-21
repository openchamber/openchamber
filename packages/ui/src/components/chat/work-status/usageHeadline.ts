import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';
import { openRouterSpendSelection } from '@/lib/quota/windowKeys';


const QUOTA_PROVIDER_ALIASES = new Map<string, string>([
  ['openai', 'codex'],
  ['chatgpt', 'codex'],
  ['anthropic', 'claude'],
  ['claude-agent', 'claude'],
  ['claude-code', 'claude'],
  ['gemini', 'google'],
  ['kilocode', 'kilo'],
  ['kilo-code', 'kilo'],
]);

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export const resolveQuotaProviderId = (modelProviderId: string | null | undefined): string | null => {
  const normalized = normalize(modelProviderId);
  if (!normalized) return null;
  return QUOTA_PROVIDER_ALIASES.get(normalized) ?? normalized;
};

type UsageHeadline = { group: UsageProviderGroup; row: UsageLimitRow };

const coversOnly = (group: UsageProviderGroup, providerId: string): boolean => (
  group.providers.length === 1 && normalize(group.providers[0]) === providerId
);

const isFinitePercent = (value: number | null): boolean => value !== null && Number.isFinite(value);

const hasMetric = (row: UsageLimitRow): boolean => {
  const { window } = row;
  return Boolean(window.value) || window.creditsUsed !== undefined || (window.valueLabel ?? null) !== null
    || isFinitePercent(window.usedPercent) || isFinitePercent(window.remainingPercent);
};

const pickGroupRow = (group: UsageProviderGroup, usable: (row: UsageLimitRow) => boolean = () => true): UsageHeadline | null => {
  const groupRows = group.rows.filter(usable);
  if (groupRows.length === 0) return null;

  const providerRows = groupRows.filter((row) => !row.subtitle);
  const rows = providerRows.length > 0 ? providerRows : groupRows;

  const windowRows = new Map(rows.filter((row) => row.key.startsWith('window-')).map((row) => [row.key.slice('window-'.length), row]));
  const openRouter = openRouterSpendSelection(group.providerId, Object.fromEntries([...windowRows].map(([key, row]) => [key, row.window])));
  const candidates = openRouter ? openRouter.capKeys.flatMap((key) => windowRows.get(key) ?? []) : rows;

  let best: UsageLimitRow | null = null;
  let bestSeconds = Number.POSITIVE_INFINITY;
  for (const row of candidates) {
    const seconds = row.window.windowSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
    if (seconds < bestSeconds) {
      best = row;
      bestSeconds = seconds;
    }
  }

  return { group, row: best ?? candidates[0] ?? (openRouter ? windowRows.get(openRouter.fallbackKey) : undefined) ?? rows[0] };
};

export const pickUsageHeadline = (
  groups: readonly UsageProviderGroup[],
  modelProviderId: string | null | undefined,
): UsageHeadline | null => {
  const quotaProviderId = resolveQuotaProviderId(modelProviderId);
  if (!quotaProviderId) return null;

  const direct = groups.find((candidate) => normalize(candidate.providerId) === quotaProviderId);
  if (direct) return pickGroupRow(direct);

  const providerId = normalize(modelProviderId);
  for (const candidate of groups) {
    if (!coversOnly(candidate, providerId)) continue;
    const headline = pickGroupRow(candidate, hasMetric);
    if (headline) return headline;
  }
  return null;
};
