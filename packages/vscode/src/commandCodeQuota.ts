type CommandCodeAmount = number | string | null | undefined;

interface CommandCodeOrgPayload {
  id?: string | null;
}

interface CommandCodeWhoamiPayload {
  org?: CommandCodeOrgPayload | null;
}

interface CommandCodeCreditsPayload {
  monthlyCredits?: CommandCodeAmount;
}

interface CommandCodeLimitPayload {
  used?: CommandCodeAmount;
  cap?: CommandCodeAmount;
  resetAt?: CommandCodeAmount;
}

interface CommandCodeWindowLimitsPayload {
  fiveHour?: CommandCodeLimitPayload | null;
  weekly?: CommandCodeLimitPayload | null;
}

interface CommandCodeBillingPayload {
  credits?: CommandCodeCreditsPayload | null;
  windowLimits?: CommandCodeWindowLimitsPayload | null;
}

interface CommandCodeUsageSummaryPayload {
  totalMonthlyCredits?: CommandCodeAmount;
}

interface CommandCodeWindowInput {
  usedPercent: number | null;
  resetAt: number | null;
  windowSeconds: number | null;
  valueLabel?: string;
}

interface CommandCodeWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: null;
  resetAfterFormatted: null;
  valueLabel?: string;
}

interface CommandCodeWindows {
  [label: string]: CommandCodeWindow;
}

const FIVE_HOUR_WINDOW_SECONDS = 18_000;
const WEEKLY_WINDOW_SECONDS = 604_800;

const toWindow = (input: CommandCodeWindowInput): CommandCodeWindow => {
  const usageWindow: CommandCodeWindow = {
    usedPercent: input.usedPercent,
    remainingPercent: input.usedPercent === null ? null : Math.max(0, 100 - input.usedPercent),
    windowSeconds: input.windowSeconds,
    resetAfterSeconds: input.resetAt === null ? null : Math.max(0, Math.floor((input.resetAt - Date.now()) / 1000)),
    resetAt: input.resetAt,
    resetAtFormatted: null,
    resetAfterFormatted: null,
  };
  if (input.valueLabel !== undefined) {
    usageWindow.valueLabel = input.valueLabel;
  }
  return usageWindow;
};

const toFiniteNumber = (value: CommandCodeAmount): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatCredits = (value: number): string => String(Math.round((value + Number.EPSILON) * 100) / 100);

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const toResetAt = (value: CommandCodeAmount): number | null => {
  const parsed = toFiniteNumber(value);
  if (parsed === null) {
    return null;
  }
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
};

const parseOrgId = (whoami: CommandCodeWhoamiPayload | null): string | null | undefined => {
  if (!(whoami instanceof Object)) {
    return undefined;
  }
  const org = whoami.org;
  if (org === null || org === undefined) {
    return null;
  }
  const rawId = org.id;
  if (rawId === null || rawId === undefined) {
    return null;
  }
  const text = String(rawId).trim();
  return text ? text : null;
};

const addLimitWindow = (
  windows: CommandCodeWindows,
  label: string,
  limit: CommandCodeLimitPayload | null | undefined,
  windowSeconds: number,
): void => {
  if (limit === null || limit === undefined) {
    return;
  }
  const used = toFiniteNumber(limit.used);
  const cap = toFiniteNumber(limit.cap);
  if (used === null || cap === null || cap <= 0) {
    return;
  }
  windows[label] = toWindow({ usedPercent: clampPercent((used / cap) * 100), resetAt: toResetAt(limit.resetAt), windowSeconds });
};

const buildCommandCodeWindows = (billing: CommandCodeBillingPayload, summaryUsed: number | null): CommandCodeWindows => {
  const windows: CommandCodeWindows = {};
  const remaining = toFiniteNumber(billing.credits?.monthlyCredits);
  if (summaryUsed !== null && remaining !== null && summaryUsed + remaining > 0) {
    windows.monthly_credits = toWindow({ usedPercent: clampPercent((summaryUsed / (summaryUsed + remaining)) * 100), resetAt: null, windowSeconds: null });
  } else if (remaining !== null) {
    windows.monthly_credits = toWindow({ usedPercent: null, resetAt: null, windowSeconds: null, valueLabel: formatCredits(remaining) });
  }
  addLimitWindow(windows, '5h', billing.windowLimits?.fiveHour, FIVE_HOUR_WINDOW_SECONDS);
  addLimitWindow(windows, 'weekly', billing.windowLimits?.weekly, WEEKLY_WINDOW_SECONDS);
  return windows;
};

const requestJson = async <JsonPayload>(requestPath: string, apiKey: string): Promise<JsonPayload> => {
  const response = await fetch(`https://api.commandcode.ai${requestPath}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) {
    throw new CommandCodeAuthenticationError();
  }
  if (!response.ok) {
    throw new Error(`Command Code usage API returned HTTP ${response.status}`);
  }
  // SAFETY: fetch JSON bodies are untyped; each caller instantiates JsonPayload with the documented endpoint contract, and the value is validated with instanceof Object plus finite-number parsing before use.
  return (await response.json().catch(() => null)) as JsonPayload;
};

export class CommandCodeAuthenticationError extends Error {
  constructor() {
    super('Command Code authentication failed');
    this.name = 'CommandCodeAuthenticationError';
  }
}

export const fetchCommandCodeUsage = async (apiKey: string): Promise<CommandCodeWindows> => {
  const whoami = await requestJson<CommandCodeWhoamiPayload | null>('/alpha/whoami', apiKey);
  const orgId = parseOrgId(whoami);
  if (orgId === undefined) {
    throw new Error('Command Code account could not be determined');
  }
  const creditsPath = orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : '/alpha/billing/credits';
  const billing = await requestJson<CommandCodeBillingPayload | null>(creditsPath, apiKey);
  if (billing === null || !(billing instanceof Object)) {
    throw new Error('Command Code usage data could not be parsed');
  }
  let summaryUsed: number | null = null;
  try {
    const summary = await requestJson<CommandCodeUsageSummaryPayload | null>('/alpha/usage/summary', apiKey);
    if (summary instanceof Object) {
      summaryUsed = toFiniteNumber(summary.totalMonthlyCredits);
    }
  } catch {
    summaryUsed = null;
  }
  const windows = buildCommandCodeWindows(billing, summaryUsed);
  if (Object.keys(windows).length === 0) {
    throw new Error('Command Code usage data could not be parsed');
  }
  return windows;
};
