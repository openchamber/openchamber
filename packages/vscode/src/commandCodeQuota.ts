type CommandCodeCredits = {
  credits?: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number };
  windowLimits?: {
    fiveHour?: { used?: number; cap?: number; resetAt?: number };
    weekly?: { used?: number; cap?: number; resetAt?: number };
  };
};

type WindowData = { usedPercent: number | null; resetAt: number | null; windowSeconds: number | null; valueLabel: string };

const toWindow = (data: WindowData) => ({
  usedPercent: data.usedPercent,
  remainingPercent: data.usedPercent === null ? null : Math.max(0, 100 - data.usedPercent),
  windowSeconds: data.windowSeconds,
  resetAfterSeconds: data.resetAt === null ? null : Math.max(0, Math.floor((data.resetAt - Date.now()) / 1000)),
  resetAt: data.resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel: data.valueLabel,
});

const toFiniteNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};
const formatCredits = (value: number): string => String(Math.round((value + Number.EPSILON) * 100) / 100);

const parseCredits = (value: unknown): CommandCodeCredits | null => {
  if (!value || typeof value !== 'object') return null;
  return value as CommandCodeCredits;
};

const parseOrgId = (value: unknown): string | null | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const org = (value as { org?: { id?: unknown } }).org;
  return typeof org?.id === 'string' && org.id.trim() ? org.id.trim() : null;
};

const parseCommandCodeCredits = (payload: CommandCodeCredits) => {
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
  for (const [label, value] of [['monthly_credits', payload.credits?.monthlyCredits], ['purchased_credits', payload.credits?.purchasedCredits], ['free_credits', payload.credits?.freeCredits]] as const) {
    const credits = toFiniteNumber(value);
    if (credits !== null) windows[label] = toWindow({ usedPercent: null, resetAt: null, windowSeconds: null, valueLabel: formatCredits(credits) });
  }
  for (const [label, limit, seconds] of [['5h', payload.windowLimits?.fiveHour, 5 * 60 * 60], ['weekly', payload.windowLimits?.weekly, 7 * 24 * 60 * 60]] as const) {
    const used = toFiniteNumber(limit?.used);
    const cap = toFiniteNumber(limit?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    const resetValue = toFiniteNumber(limit?.resetAt);
    const resetAt = resetValue === null ? null : resetValue < 1_000_000_000_000 ? resetValue * 1000 : resetValue;
    windows[label] = toWindow({ usedPercent: Math.min(100, Math.max(0, used / cap * 100)), resetAt, windowSeconds: seconds, valueLabel: `${formatCredits(used)} / ${formatCredits(cap)}` });
  }
  return windows;
};

const requestJson = async (requestPath: string, apiKey: string): Promise<unknown> => {
  const response = await fetch(`https://api.commandcode.ai${requestPath}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new Error('Command Code authentication failed');
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`);
  return response.json().catch(() => null);
};

export const fetchCommandCodeUsage = async (apiKey: string) => {
  const orgId = parseOrgId(await requestJson('/alpha/whoami', apiKey));
  if (orgId === undefined) throw new Error('Command Code account could not be determined');
  const creditsPath = orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : '/alpha/billing/credits';
  const payload = parseCredits(await requestJson(creditsPath, apiKey));
  if (!payload) throw new Error('Command Code usage data could not be parsed');
  const windows = parseCommandCodeCredits(payload);
  if (!Object.keys(windows).length) throw new Error('Command Code usage data could not be parsed');
  return windows;
};
