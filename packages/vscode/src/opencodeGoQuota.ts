import { z } from 'zod';

export type OpenCodeGoApiKeyCredential = { apiKey: string; consoleKey: boolean };
export type OpenCodeGoConsoleCredential = { accessToken: string; orgID: string; expires?: number | null };
type OpenCodeGoCredential = OpenCodeGoApiKeyCredential | OpenCodeGoConsoleCredential;

const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus', 'go-teams']);
const NO_CONSOLE_SUBSCRIPTION = 'No active OpenCode Go subscription on the selected Console account';
export const OPENCODE_GO_KEY_EXPIRED = 'OpenCode Go key expired. Connect an OpenCode Console account on the OpenCode card in Providers.';

const numericValue = z.union([
  z.string().transform((value) => Number(value)),
  z.number(),
]).pipe(z.number().finite());
const resetTimestamp = z.union([
  z.string().transform((value) => Date.parse(value)),
  z.number(),
]).pipe(z.number().finite().transform((value) => value < 1_000_000_000_000 ? value * 1000 : value));

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

type OpenCodeGoWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
};

const toWindow = (usedPercent: number, resetAt: number): OpenCodeGoWindow => ({
  usedPercent: clampPercent(usedPercent),
  remainingPercent: clampPercent(100 - usedPercent),
  windowSeconds: null,
  resetAfterSeconds: Math.max(0, Math.floor((resetAt - Date.now()) / 1000)),
  resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const toBalanceWindow = (valueLabel: string): OpenCodeGoWindow => ({
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel,
});

const apiKeyWindowSchema = z.object({
  percent: numericValue.catch(Number.NaN),
  resetsAt: resetTimestamp.catch(Number.NaN),
}).catch({ percent: Number.NaN, resetsAt: Number.NaN });
const apiKeyStatusSchema = z.object({
  usage: z.record(z.string(), apiKeyWindowSchema).optional(),
});
type OpenCodeGoApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;
const apiKeyErrorSchema = z.object({ error: z.object({ code: z.literal('api_key_expired') }) });

const parseApiKeyUsage = (payload: OpenCodeGoApiKeyStatus) => {
  const windows: Record<string, OpenCodeGoWindow> = {};
  const usage = payload.usage;
  if (!usage) return windows;
  for (const [key, apiKey] of Object.entries({ '5h': 'rolling', weekly: 'weekly', monthly: 'monthly' })) {
    const entry = usage[apiKey];
    if (!entry || !Number.isFinite(entry.percent) || !Number.isFinite(entry.resetsAt)) continue;
    windows[key] = toWindow(entry.percent, entry.resetsAt);
  }
  return windows;
};

const consoleMeterSchema = z.object({
  limitMicroCents: numericValue.optional().catch(undefined),
  usedMicroCents: numericValue.optional().catch(undefined),
  resetsAt: resetTimestamp.optional().catch(undefined),
}).catch({});
const consoleStatusSchema = z.object({
  product: z.string().optional(),
  access: z.object({
    meters: z.record(z.string(), consoleMeterSchema).optional(),
  }).nullish(),
});
type OpenCodeGoConsoleStatus = z.infer<typeof consoleStatusSchema>;

const consoleBillingSchema = z.object({
  availableMicroCents: numericValue.optional().catch(undefined),
});

const parseConsoleUsage = (payload: OpenCodeGoConsoleStatus) => {
  const windows: Record<string, OpenCodeGoWindow> = {};
  const meters = payload.access?.meters;
  if (!meters) return windows;
  for (const [key, meterName] of Object.entries({ '5h': 'fiveHour', weekly: 'week', monthly: 'month' })) {
    const meter = meters[meterName];
    if (!meter) continue;
    const limit = meter.limitMicroCents ?? null;
    const used = meter.usedMicroCents ?? null;
    const resetAt = meter.resetsAt ?? null;
    if (limit === null || limit <= 0 || used === null || used < 0 || resetAt === null) continue;
    windows[key] = toWindow((used / limit) * 100, resetAt);
  }
  return windows;
};

const fetchConsoleUsageWithKey = async (apiKey: string) => {
  try {
    const response = await fetch(CONSOLE_STATUS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const parsed = consoleStatusSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || !parsed.data.product || !CONSOLE_PRODUCTS.has(parsed.data.product)) return null;
    const windows = parseConsoleUsage(parsed.data);
    return Object.keys(windows).length ? windows : null;
  } catch {
    return null;
  }
};

const fetchApiKeyUsage = async (credential: OpenCodeGoApiKeyCredential) => {
  const consoleWindows = await fetchConsoleUsageWithKey(credential.apiKey);
  if (consoleWindows) return consoleWindows;
  const response = await fetch(API_KEY_USAGE_URL, { headers: { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}`, 'x-opencode-session': 'openchamber-usage' }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 403 && credential.consoleKey) throw new Error(NO_CONSOLE_SUBSCRIPTION);
  if (response.status === 401 && apiKeyErrorSchema.safeParse(await response.json().catch(() => null)).success) throw new Error(OPENCODE_GO_KEY_EXPIRED);
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new Error('OpenCode Go authentication failed');
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const parsed = apiKeyStatusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenCode Go usage data could not be parsed');
  const windows = parseApiKeyUsage(parsed.data);
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const fetchConsoleBillingBalance = async (credential: OpenCodeGoConsoleCredential) => {
  try {
    const response = await fetch(CONSOLE_BILLING_STATUS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`, 'x-org-id': credential.orgID },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const parsed = consoleBillingSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;
    const microCents = parsed.data.availableMicroCents;
    if (microCents == null || microCents < 0) return null;
    return microCents / MICRO_CENTS_PER_DOLLAR;
  } catch {
    return null;
  }
};

const fetchConsoleUsage = async (credential: OpenCodeGoConsoleCredential) => {
  if (credential.expires != null && credential.expires > 0 && credential.expires <= Date.now()) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  const balanceRead = fetchConsoleBillingBalance(credential);
  const response = await fetch(CONSOLE_STATUS_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`, 'x-org-id': credential.orgID },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`);
  const parsed = consoleStatusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenCode Console Go status returned an unreadable response');
  if (!parsed.data.product || !CONSOLE_PRODUCTS.has(parsed.data.product) || parsed.data.access == null) throw new Error(NO_CONSOLE_SUBSCRIPTION);
  const windows = parseConsoleUsage(parsed.data);
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  const balance = await balanceRead;
  if (balance !== null) windows.credits_balance = toBalanceWindow(`$${balance.toFixed(2)}`);
  return windows;
};

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) =>
  'apiKey' in credential ? fetchApiKeyUsage(credential) : fetchConsoleUsage(credential);
