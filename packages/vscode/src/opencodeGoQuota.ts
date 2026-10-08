import { z } from 'zod';

type OpenCodeGoApiKeyCredential = { apiKey: string };
export type OpenCodeGoConsoleCredential = { accessToken: string; orgID: string; expires?: number | null };
type OpenCodeGoCredential = OpenCodeGoApiKeyCredential | OpenCodeGoConsoleCredential;

const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus']);

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

const toWindow = (usedPercent: number, resetAt: number) => ({
  usedPercent: clampPercent(usedPercent),
  remainingPercent: clampPercent(100 - usedPercent),
  windowSeconds: null,
  resetAfterSeconds: Math.max(0, Math.floor((resetAt - Date.now()) / 1000)),
  resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const apiKeyWindowSchema = z.object({
  percent: numericValue.catch(Number.NaN),
  resetsAt: resetTimestamp.catch(Number.NaN),
}).catch({ percent: Number.NaN, resetsAt: Number.NaN });
const apiKeyStatusSchema = z.object({
  usage: z.record(z.string(), apiKeyWindowSchema).optional(),
});
type OpenCodeGoApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

const parseApiKeyUsage = (payload: OpenCodeGoApiKeyStatus) => {
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
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

const parseConsoleUsage = (payload: OpenCodeGoConsoleStatus) => {
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
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

const fetchApiKeyUsage = async (credential: OpenCodeGoApiKeyCredential) => {
  const response = await fetch(API_KEY_USAGE_URL, { headers: { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}`, 'x-opencode-session': 'openchamber-usage' }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new Error('OpenCode Go authentication failed');
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const parsed = apiKeyStatusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenCode Go usage data could not be parsed');
  const windows = parseApiKeyUsage(parsed.data);
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const fetchConsoleUsage = async (credential: OpenCodeGoConsoleCredential) => {
  if (credential.expires != null && credential.expires > 0 && credential.expires <= Date.now()) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
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
  if (!parsed.data.product || !CONSOLE_PRODUCTS.has(parsed.data.product)) throw new Error('No active OpenCode Go subscription on the selected Console account');
  const windows = parseConsoleUsage(parsed.data);
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) =>
  'apiKey' in credential ? fetchApiKeyUsage(credential) : fetchConsoleUsage(credential);
