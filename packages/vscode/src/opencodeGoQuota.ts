import { z } from 'zod';

// `consoleKey` marks a key from the shared `opencode` integration.
export type OpenCodeGoApiKeyCredential = { apiKey: string; consoleKey: boolean };
export type OpenCodeGoConsoleCredential = { accessToken: string; orgID: string; expires?: number | null };
type OpenCodeGoCredential = OpenCodeGoApiKeyCredential | OpenCodeGoConsoleCredential;

const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
// The Go status response carries only the three meters. The spendable credit
// balance that overage draws from lives on the Console billing status, read with
// the same Console token and organization.
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
// The Console counts one cent as 1_000_000 micro-cents, so a dollar is 100_000_000.
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus']);
const NO_CONSOLE_SUBSCRIPTION = 'No active OpenCode Go subscription on the selected Console account';
// Console keys expire and nothing can renew them, while a Console sign-in is
// renewed by OpenCode and serves OpenCode Go too. Providers offers that sign-in
// as the "OpenCode Console account" row on the OpenCode card.
export const OPENCODE_GO_KEY_EXPIRED = 'OpenCode Go key expired. Connect an OpenCode Console account on the OpenCode card in Providers.';

// The Console and legacy Go endpoints report amounts as decimal strings (the
// Console uses integer micro-cents), so both schemas decode them once at the
// HTTP boundary into finite numbers.
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

// A balance is a fixed amount, not a window: no percent, no reset.
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
// The usage API answers an expired key with 401 and
// `{ error: { code: 'api_key_expired' } }`; any other 401 stays a plain
// authentication failure.
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

// Each meter is decoded on its own and a malformed one falls back to an empty
// object, so one bad window never discards the others. A missing, negative, or
// zero limit and an invalid reset are rejected by the caller, never divided by.
const consoleMeterSchema = z.object({
  limitMicroCents: numericValue.optional().catch(undefined),
  usedMicroCents: numericValue.optional().catch(undefined),
  resetsAt: resetTimestamp.optional().catch(undefined),
}).catch({});
const consoleStatusSchema = z.object({
  product: z.string().optional(),
  access: z.object({
    meters: z.record(z.string(), consoleMeterSchema).optional(),
  }).optional(),
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

// An API key also opens the Console Go status, without `x-org-id`: the key
// belongs to one workspace. Its meters carry the exact fraction the Console page
// rounds, while the usage API reports a floored integer percent that sits up to
// a point below the page. Best-effort: any failure returns null and the usage
// API answers instead, so its error messages stay the API-key contract.
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
  // The usage API accepts any key of a Console workspace and answers 403 when
  // that workspace has no Go subscription, so for a Console key a 403 is an
  // absent subscription rather than a bad key.
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

// Best-effort. The Go meters are the authoritative result, so a billing read
// that fails (network, HTTP, malformed) drops the credits row instead of failing
// the refresh or reporting a $0.00 balance. It runs alongside the Go read, so a
// slow billing endpoint never delays the meters by more than the slower of the
// two requests; its result is used only when the Go read succeeds.
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
    // The bearer token belongs to opencode.ai/console; never follow a redirect
    // that would forward it to another origin.
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`);
  const parsed = consoleStatusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenCode Console Go status returned an unreadable response');
  if (!parsed.data.product || !CONSOLE_PRODUCTS.has(parsed.data.product)) throw new Error(NO_CONSOLE_SUBSCRIPTION);
  const windows = parseConsoleUsage(parsed.data);
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  const balance = await balanceRead;
  if (balance !== null) windows.credits_balance = toBalanceWindow(`$${balance.toFixed(2)}`);
  return windows;
};

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) =>
  'apiKey' in credential ? fetchApiKeyUsage(credential) : fetchConsoleUsage(credential);
