import { z } from 'zod';
import { OPENCODE_CONFIG_DIR, OPENCODE_DATA_DIR } from './opencodeConfigPaths';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchOpenCodeGoUsage, type OpenCodeGoApiKeyCredential, type OpenCodeGoConsoleCredential } from './opencodeGoQuota';
import { deleteLegacyOllamaCloudCredential, deleteLegacyOpenCodeGoCredential, readCredential } from './quotaCredentials';
import { readOpenCodeCredentials } from './opencodeAuth';
import { readConfig } from './opencodeConfig';
import { isRecord, toProviderEntity } from './opencode-config-v2';
import { fetchExeDevUsage } from './exeDevQuota';
import { QUOTA_RESPONSE_MAX_BYTES, readBoundedResponseBody, ResponseBodyTooLargeError } from './bounded-response-body';
import { refreshGoogleAccessToken } from '../../web/server/lib/quota/providers/google/oauth.js';
import { antigravityHeaders, warnIfGeminiGroupMissing } from '../../web/server/lib/quota/providers/antigravity/client.js';

type AuthEntry = Record<string, unknown> | string;
type AuthFile = Record<string, AuthEntry>;

type UsageWindowGiftReset = {
  recordId: number;
  expireAt: number;
};

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  giftReset?: UsageWindowGiftReset | null;
};

type ProviderUsage = {
  windows: Record<string, UsageWindow>;
  models?: Record<string, ProviderUsage>;
  usageAvailability?: 'console-only';
};

type OpenAiUsagePayload = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
    secondary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
  };
  credits?: {
    balance?: number | string;
    unlimited?: boolean;
  };
  spend_control?: {
    individual_limit?: {
      limit?: number | string;
      used?: number | string;
      used_percent?: number | string;
    };
  };
};

type GoogleModelsPayload = {
  models?: Record<string, {
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
  }>;
};

type GoogleQuotaBucketsPayload = {
  buckets?: Array<{
    modelId?: string;
    remainingFraction?: number;
    resetTime?: string;
  }>;
};

type ZaiLimit = {
  type?: string;
  number?: number;
  unit?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  nextResetTime?: number;
  percentage?: number;
};

// CREDIT_LIMIT entries carry `usage` (total credits) and `currentValue` (consumed);
// TOKENS_LIMIT entries only carry a percentage.
const formatZaiCreditAmount = (value: number): string => {
  if (value < 1000) return value.toLocaleString('en-US');
  return `${Math.round(value / 100) / 10}k`;
};

const formatZaiCreditValueLabel = (limit: ZaiLimit): string | null => {
  const used = toNumber(limit.currentValue);
  const total = toNumber(limit.usage);
  if (used === null || total === null) return null;
  return `${formatZaiCreditAmount(used)} / ${formatZaiCreditAmount(total)} credits`;
};

type ZaiPayload = {
  code?: number | null;
  msg?: string | null;
  success?: boolean;
  data?: {
    limits?: ZaiLimit[];
    level?: string;
  };
};

type ZaiGiftResetRecord = {
  recordId?: number;
  expireTime?: string;
  available?: boolean;
};

type ZaiGiftResetPayload = {
  data?: {
    fiveHourResets?: ZaiGiftResetRecord[];
    weekResets?: ZaiGiftResetRecord[];
  };
};

type ZaiGiftResetUsePayload = {
  msg?: string;
  success?: boolean;
};

type ZhipuaiLimit = {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
};

type ZhipuaiPayload = {
  code?: number | null;
  msg?: string | null;
  success?: boolean;
  data?: {
    limits?: ZhipuaiLimit[];
    level?: string;
  };
};

// Mirrors the Z.ai credit label (same monitor API family): `usage` is the
// total, `currentValue` the consumed amount.
const formatZhipuaiCreditAmount = (value: number): string => {
  if (value < 1000) return value.toLocaleString('en-US');
  return `${Math.round(value / 100) / 10}k`;
};

const formatZhipuaiCreditValueLabel = (limit: ZhipuaiLimit): string | null => {
  const used = toNumber(limit.currentValue);
  const total = toNumber(limit.usage);
  if (used === null || total === null) return null;
  return `${formatZhipuaiCreditAmount(used)} / ${formatZhipuaiCreditAmount(total)} credits`;
};

const clampPercent = (value: number): number | null => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

// `percentage` is the used percent; when the API omits it, derive it from
// currentValue/usage (observed percentages are integers).
const resolveZhipuaiUsedPercent = (limit: ZhipuaiLimit): number | null => {
  const percentage = toNumber(limit.percentage);
  if (percentage !== null) {
    return clampPercent(percentage);
  }
  const used = toNumber(limit.currentValue);
  const total = toNumber(limit.usage);
  if (used === null || total === null || total <= 0) return null;
  return clampPercent(Math.round((used / total) * 100));
};

// bigmodel.cn reports business failures inside HTTP 200 bodies
// (`{code, msg, success: false}`); a missing envelope is treated as legacy success.
const zhipuaiEnvelopeError = (payload: ZhipuaiPayload): string | null => {
  const code = payload?.code;
  if (payload?.success !== false && !(code !== undefined && code !== null && code !== 200)) {
    return null;
  }
  return asNonEmptyString(payload?.msg) ?? `API error: ${code ?? 'unknown'}`;
};

type WaferPayload = {
  remaining_included_requests?: number | string;
  included_request_limit?: number | string;
  overage_request_count?: number | string;
  current_period_used_percent?: number | string;
  window_start?: number | string;
  window_end?: number | string;
  plan_tier?: string;
};

type ClineWindowKind = {
  key: string;
  windowSeconds: number | null;
};

type DeepseekPayload = {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: number | string;
    granted_balance?: number | string;
    topped_up_balance?: number | string;
  }>;
};

type DeepinfraPayload = {
  checklist?: {
    stripe_balance?: number | string;
    recent?: number | string;
    limit?: number | string | null;
  } | null;
};

type NeuralwattPayload = {
  balance?: {
    credits_remaining_usd?: number | string;
  };
  subscription?: {
    plan?: string;
    billing_interval?: string;
    current_period_start?: string;
    current_period_end?: string;
    kwh_included?: number | string;
    kwh_used?: number | string;
    in_overage?: boolean;
    kwh_reset_date?: string;
  } | null;
  key?: {
    name?: string;
    allowance?: {
      limit_usd?: number | string;
      period?: string;
      spent_usd?: number | string;
      blocked?: boolean;
      reset_at?: string;
    } | null;
  };
};

type ProviderResult = {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: ProviderUsage | null;
  fetchedAt: number;
  error?: string;
  planLabel?: string | null;
  /** The plan is walled (402-class), distinct from a read failure (`ok: false`). */
  quotaExhausted?: boolean;
  /** When the walled window resets, epoch milliseconds, when the provider says. */
  quotaResetAt?: number | null;
  /** Why a read failed, in the provider's own classes (meta: unauthorized/inactive/exhausted/transport/malformed/http-error/no-data). */
  failureClass?: string;
  /** Epoch ms of the provider's last successful read in this process, or null when none has succeeded yet. */
  lastSuccessAt?: number | null;
};


const XAI_USAGE_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const XAI_ACCESS_EXPIRY_SKEW_MS = 120_000;

type XaiAuthEntry = Record<string, unknown> & {
  type: 'oauth';
  access?: string;
  refresh?: string;
  expires?: unknown;
};

const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json'),
];

const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GOOGLE_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const GOOGLE_PRIMARY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

const GOOGLE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  GOOGLE_PRIMARY_ENDPOINT,
];

// Antigravity reaches the production daily host first and never the autopush
// sandbox; Gemini CLI keeps the endpoint order above.
const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  GOOGLE_PRIMARY_ENDPOINT,
];

const GOOGLE_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

const resolveGoogleWindow = (sourceId: GoogleAuthSource['sourceId'], resetAt: number | null) => {
  if (sourceId === 'gemini') {
    // The per-model projection of the Code Assist subscription the
    // Antigravity provider reads (#1042): not a separate daily pool,
    // and the payload carries no window duration - only each bucket's
    // real resetTime - so the window claims no duration.
    return { label: 'per-model', seconds: null } as const;
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 36 * 60 * 60) {
      return { label: 'weekly', seconds: GOOGLE_WEEKLY_WINDOW_SECONDS } as const;
    }

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS } as const;
  }

  return { label: 'per-model', seconds: null } as const;
};

const ZAI_TOKEN_WINDOW_SECONDS: Record<number, number> = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60,
};

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

const getAuthEntry = (auth: AuthFile, aliases: string[]) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

const normalizeAuthEntry = (entry: AuthEntry | null) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry } as Record<string, unknown>;
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};

const asObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Reads a quota provider answer as JSON under QUOTA_RESPONSE_MAX_BYTES
 * (the shared cap in bounded-response-body.ts, #1282), preserving the old
 * bare response.json() semantics for in-cap bodies: a malformed body
 * throws from JSON.parse exactly as response.json() did, and an over-cap
 * body throws ResponseBodyTooLargeError instead of being buffered whole,
 * so each caller's existing failure path produces the provider's normal
 * failure result. The web twin is readQuotaJson in
 * packages/web/server/lib/quota/utils/response-body.js.
 */
type QuotaJsonValue = string | number | boolean | null | QuotaJsonValue[] | { [key: string]: QuotaJsonValue };

const readQuotaJson = async (response: Response): Promise<QuotaJsonValue> => {
  // Test doubles pass a plain { ok, json } without a body; real responses
  // go through the bounded reader.
  if (!response.body) {
    // SAFETY: only test doubles reach this fallback (a real Response always
    // has a body); their json() returns an already-parsed JSON value, which
    // is exactly the QuotaJsonValue shape.
    return (await response.json()) as QuotaJsonValue;
  }
  const bytes = await readBoundedResponseBody(response, QUOTA_RESPONSE_MAX_BYTES);
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  return JSON.parse(text);
};

/**
 * The same bounded read for the one binary quota answer (xAI's protobuf
 * usage body): the cap is enforced while the body streams in.
 */
const readQuotaBytes = async (response: Response): Promise<Uint8Array> => {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > QUOTA_RESPONSE_MAX_BYTES) throw new ResponseBodyTooLargeError(QUOTA_RESPONSE_MAX_BYTES);
    return bytes;
  }
  return readBoundedResponseBody(response, QUOTA_RESPONSE_MAX_BYTES);
};

/**
 * The Ollama Cloud API key on one auth entry, or null.
 *
 * Mirrors `apiKeyFromAuth` in the web server's `ollama-cloud.js`: the key a chat
 * request would use, so the tracker reports on the account OpenCode has active.
 */
const ollamaApiKeyFrom = (entry: ReturnType<typeof normalizeAuthEntry>): string | null =>
  asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

/**
 * The shared credential selection for the key/token and access/token
 * provider families (#1759): the first field holding a real value,
 * trimmed, or null. listConfiguredQuotaProviders and every fetch path
 * select through these, so an empty or whitespace-only first field
 * falls through to the second field identically on both sides, and a
 * blank credential is never sent as a bearer.
 */
const keyOrTokenFrom = (entry: unknown): string | null => {
  const record = asObject(entry);
  return asNonEmptyString(record?.key) ?? asNonEmptyString(record?.token);
};

const accessOrTokenFrom = (entry: unknown): string | null => {
  const record = asObject(entry);
  return asNonEmptyString(record?.access) ?? asNonEmptyString(record?.token);
};

const parseGoogleRefreshToken = (rawRefreshToken: unknown) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject),
  };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const toTimestamp = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// OpenCode Console signs in through the shared `opencode` integration and
// records the Console server and selected organization on the credential. Only
// a Console sign-in counts: its OAuth access token is not interchangeable with
// an `opencode-go` service key. Credentials are global and OpenCode marks one
// active per integration, so this is the selected account and organization.
const CONSOLE_SERVER = 'https://opencode.ai/console';
// Console workspaces carry a `wrk_` id on current sign-ins; older stored
// credentials still carry `org_`, so both prefixes count and nothing else.
const CONSOLE_ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/;
const openCodeGoConsoleCredential = (auth: AuthFile): OpenCodeGoConsoleCredential | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['opencode']));
  if (!entry || entry.type !== 'oauth') return null;
  const accessToken = asNonEmptyString(entry.access);
  const orgID = asNonEmptyString(entry.orgID);
  if (!accessToken || entry.server !== CONSOLE_SERVER || !orgID || !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) return null;
  const expires = toNumber(entry.expires);
  return { accessToken, orgID, expires };
};

// A key on `opencode-go` comes first. Otherwise an API key on the shared
// `opencode` integration serves Go too: OpenCode loads the Console workspace's
// providers with it and binds OpenCode Go to that integration when the
// workspace has Go. Providers lists it under OpenCode Go too.
const openCodeGoApiKey = (auth: AuthFile): OpenCodeGoApiKeyCredential | null => {
  const own = normalizeAuthEntry(getAuthEntry(auth, ['opencode-go']));
  const ownKey = asNonEmptyString(own?.key) ?? asNonEmptyString(own?.token);
  if (ownKey) return { apiKey: ownKey, consoleKey: false };
  const consoleEntry = normalizeAuthEntry(getAuthEntry(auth, ['opencode']));
  if (!consoleEntry || consoleEntry.type === 'oauth') return null;
  const consoleKey = asNonEmptyString(consoleEntry.key) ?? asNonEmptyString(consoleEntry.token);
  return consoleKey ? { apiKey: consoleKey, consoleKey: true } : null;
};

const formatResetTime = (timestamp: number) => {
  try {
    const resetDate = new Date(timestamp);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      // Same day: show time only (e.g., "9:56 PM")
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    // Different day: show date + weekday + time (e.g., "Feb 2, Sun 9:56 PM")
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

const calculateResetAfterSeconds = (resetAt: number | null) => {
  if (!resetAt) return null;
  const delta = Math.floor((resetAt - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

const toUsageWindow = (data: { usedPercent: number | null; windowSeconds: number | null; resetAt: number | null; valueLabel?: string | null }) => {
  const resetAfterSeconds = calculateResetAfterSeconds(data.resetAt);
  const resetFormatted = data.resetAt ? formatResetTime(data.resetAt) : null;
  return {
    usedPercent: data.usedPercent,
    remainingPercent: data.usedPercent !== null ? Math.max(0, 100 - data.usedPercent) : null,
    windowSeconds: data.windowSeconds ?? null,
    resetAfterSeconds,
    resetAt: data.resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(data.valueLabel ? { valueLabel: data.valueLabel } : {}),
  } satisfies UsageWindow;
};

const buildResult = (data: {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: ProviderUsage | null;
  error?: string;
  planLabel?: string | null;
}): ProviderResult => {
  const result: ProviderResult = {
    providerId: data.providerId,
    providerName: data.providerName,
    ok: data.ok,
    configured: data.configured,
    usage: data.usage ?? null,
    ...(data.error ? { error: data.error } : {}),
    fetchedAt: Date.now(),
  };
  if (data.planLabel) result.planLabel = data.planLabel;
  return result;
};

const resolveXaiAuth = (auth: AuthFile): XaiAuthEntry | null => {
  const entry = auth.xai;
  if (!entry || typeof entry !== 'object' || entry.type !== 'oauth') return null;

  const access = asNonEmptyString(entry.access);
  const refresh = asNonEmptyString(entry.refresh);
  if (!access && !refresh) return null;

  return {
    ...entry,
    type: 'oauth',
    ...(access ? { access } : {}),
    ...(refresh ? { refresh } : {}),
    ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
  };
};

const jwtExpiryMilliseconds = (accessToken: string): number | null => {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : null;
  } catch {
    return null;
  }
};

const xaiAccessExpired = (entry: XaiAuthEntry, now = Date.now()): boolean => {
  const access = asNonEmptyString(entry.access);
  if (!access) return true;

  const expiryDeadline = now + XAI_ACCESS_EXPIRY_SKEW_MS;
  const storedExpiry = Number(entry.expires);
  if (Number.isFinite(storedExpiry) && storedExpiry <= expiryDeadline) {
    return true;
  }

  const jwtExpiry = jwtExpiryMilliseconds(access);
  return jwtExpiry !== null && jwtExpiry <= expiryDeadline;
};

// xAI rotates (and rejects the previous) refresh token on every exchange, and
// OpenCode 2.x owns the credential store without exposing a refresh route. A
// quota read that refreshed here would burn the token OpenCode still holds and
// sign the user out. Claude's provider makes the same call; wait for OpenCode
// to refresh and surface the stale state instead.
const requireXaiAccessToken = (entry: XaiAuthEntry): string => {
  const access = asNonEmptyString(entry.access);
  if (!access || xaiAccessExpired(entry)) {
    throw new Error('xAI access token expired — send a Grok message or re-authorize');
  }
  return access;
};

type XaiFixed32Field = { path: number[]; value: number; order: number };
type XaiVarintField = { path: number[]; value: bigint };
type XaiProtobufScan = {
  fixed32Fields: XaiFixed32Field[];
  varintFields: XaiVarintField[];
  nextOrder: number;
};

const readXaiVarint = (bytes: Uint8Array, index: { value: number }): bigint | null => {
  let result = 0n;
  for (let shift = 0n; index.value < bytes.length && shift < 64n; shift += 7n) {
    const byte = bytes[index.value++];
    if (shift === 63n && (byte & 0x7e) !== 0) return null;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
  }
  return null;
};

const scanXaiProtobuf = (
  bytes: Uint8Array,
  depth: number,
  pathPrefix: number[],
  scan: XaiProtobufScan,
): boolean => {
  const index = { value: 0 };
  while (index.value < bytes.length) {
    const fieldKey = readXaiVarint(bytes, index);
    if (fieldKey === null || fieldKey === 0n) return false;

    const fieldNumber = Number(fieldKey >> 3n);
    const wireType = Number(fieldKey & 0x07n);
    if (fieldNumber < 1 || fieldNumber > 0x1fffffff) return false;
    const fieldPath = [...pathPrefix, fieldNumber];

    if (wireType === 0) {
      const value = readXaiVarint(bytes, index);
      if (value === null) return false;
      scan.varintFields.push({ path: fieldPath, value });
      continue;
    }

    if (wireType === 1) {
      if (index.value + 8 > bytes.length) return false;
      index.value += 8;
      continue;
    }

    if (wireType === 2) {
      const length = readXaiVarint(bytes, index);
      if (length === null || length > BigInt(bytes.length - index.value)) return false;
      const start = index.value;
      index.value += Number(length);
      if (depth >= 4 && length !== 0n) return false;
      if (depth < 4) {
        const nestedScan: XaiProtobufScan = {
          fixed32Fields: [],
          varintFields: [],
          nextOrder: scan.nextOrder,
        };
        if (!scanXaiProtobuf(bytes.subarray(start, index.value), depth + 1, fieldPath, nestedScan)) return false;
        scan.fixed32Fields.push(...nestedScan.fixed32Fields);
        scan.varintFields.push(...nestedScan.varintFields);
        scan.nextOrder = nestedScan.nextOrder;
      }
      continue;
    }

    if (wireType === 5) {
      if (index.value + 4 > bytes.length) return false;
      const value = new DataView(bytes.buffer, bytes.byteOffset + index.value, 4).getFloat32(0, true);
      scan.fixed32Fields.push({ path: fieldPath, value, order: scan.nextOrder++ });
      index.value += 4;
      continue;
    }

    return false;
  }

  return true;
};

const looksLikeXaiProtobuf = (bytes: Uint8Array): boolean => {
  if (!bytes.length) return false;
  const fieldNumber = Math.floor(bytes[0] / 8);
  const wireType = bytes[0] % 8;
  return fieldNumber > 0 && [0, 1, 2, 5].includes(wireType);
};

const parseXaiGrpcTrailerStatus = (bytes: Uint8Array): number | null => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let status: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!key) return null;
    if (key !== 'grpc-status') continue;
    if (status !== null) return null;
    const rawStatus = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(rawStatus)) return null;
    status = Number(rawStatus);
    if (!Number.isSafeInteger(status)) return null;
  }
  return status;
};

const parseXaiGrpcFrames = (bytes: Uint8Array): { payloads: Uint8Array[]; trailerStatuses: number[] } | null | false => {
  if (bytes.length < 5 || (bytes[0] & 0x7f) !== 0) return null;
  const payloads: Uint8Array[] = [];
  const trailerStatuses: number[] = [];
  let index = 0;
  let sawTrailer = false;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) return false;
    const flags = bytes[index++];
    if ((flags & 0x7f) !== 0) return false;
    const length = (bytes[index++] * 0x1000000) + (bytes[index++] << 16) + (bytes[index++] << 8) + bytes[index++];
    if (length > bytes.length - index) return false;
    const frame = bytes.subarray(index, index + length);
    index += length;
    if (flags & 0x80) {
      sawTrailer = true;
      const status = parseXaiGrpcTrailerStatus(frame);
      if (status === null) return false;
      trailerStatuses.push(status);
    } else {
      if (sawTrailer) return false;
      payloads.push(frame);
    }
  }
  return { payloads, trailerStatuses };
};

const sameXaiPath = (left: number[], right: number[]) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const XAI_USAGE_PERCENT_PATHS = [[1], [1, 1]];
const isXaiUsagePercentPath = (path: number[]) => (
  XAI_USAGE_PERCENT_PATHS.some((candidate) => sameXaiPath(candidate, path))
);

const parseXaiUsage = (bytes: Uint8Array): { usedPercent: number; resetAt: number | null } => {
  const frames = parseXaiGrpcFrames(bytes);
  if (frames === false) throw new Error('xAI returned malformed gRPC-web framing');
  const payloads = frames === null
    ? (looksLikeXaiProtobuf(bytes) ? [bytes] : [])
    : frames.payloads;
  if (frames) {
    for (const status of frames.trailerStatuses) {
      if (status !== 0) throw new Error(`xAI billing RPC failed with status ${status}`);
    }
  }
  if (!payloads.length) throw new Error('xAI returned an empty protobuf response');

  const scan: XaiProtobufScan = { fixed32Fields: [], varintFields: [], nextOrder: 0 };
  for (const payload of payloads) {
    if (!scanXaiProtobuf(payload, 0, [], scan)) throw new Error('xAI returned malformed protobuf data');
  }

  const percentField = scan.fixed32Fields
    .filter((field) => isXaiUsagePercentPath(field.path) && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0];
  const resetCandidates = scan.varintFields
    .filter((field) => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n)
    .map((field) => ({ path: field.path, seconds: Number(field.value) }))
    .map((field) => ({ path: field.path, timestamp: field.seconds * 1000 }))
    .filter((field) => field.timestamp > Date.now());
  const preferredReset = resetCandidates
    .filter((field) => sameXaiPath(field.path, [1, 5, 1]))
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  const resetAt = (preferredReset ?? resetCandidates.sort((a, b) => a.timestamp - b.timestamp)[0])?.timestamp ?? null;
  const hasUsagePeriod = scan.varintFields.some((field) => (
    (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6)
    || (sameXaiPath(field.path, [1, 8, 1]) && (field.value === 1n || field.value === 2n))
  ));
  const noUsageYet = !percentField && scan.fixed32Fields.length === 0 && resetAt !== null && hasUsagePeriod;
  const usedPercent = percentField?.value ?? (noUsageYet ? 0 : null);
  if (usedPercent === null) throw new Error('xAI billing response did not contain usable current-period data');
  return { usedPercent, resetAt };
};

const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

const durationToLabel = (duration?: number, unit?: string) => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

const durationToSeconds = (duration?: number, unit?: string) => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

// OpenCode stores the Kimi For Coding plans as `kimi-code-plan-cn` (kimi.com)
// and `kimi-code-plan-global` (kimi.ai). The China plan comes first: its key
// works at the api.kimi.com usage address, and a pre-split `kimi-for-coding`
// key left behind with a dead credential must not shadow it. The global plan
// stays last, as before, since its key is not known to work at that address.
const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global'];

const getKimiApiKey = (auth: AuthFile) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, KIMI_AUTH_ALIASES));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

/**
 * Providers turned off in the merged OpenCode config (`disabled_providers`).
 * A config that cannot be read is logged and answers an empty set, so the
 * failure is visible instead of silently changing which providers list.
 * Mirrors packages/web/server/lib/quota/providers/index.js (kept in sync
 * per the quota DOCUMENTATION.md parity note).
 */
const readDisabledQuotaProviderIds = (): Set<string> => {
  try {
    const config = readConfig();
    const disabled = new Set<string>();
    if (Array.isArray(config.disabled_providers)) {
      for (const entry of config.disabled_providers) {
        const id = asNonEmptyString(entry);
        if (id) disabled.add(id);
      }
    }
    return disabled;
  } catch (error) {
    console.warn('Quota: failed to read the OpenCode config; listing without the disabled filter.', error);
    return new Set();
  }
};

const CODEX_AUTH_ALIASES = ['openai', 'codex', 'chatgpt'];

/**
 * The ids of configured provider instances of a Codex base (`openai`, ...),
 * in merged-config order. Since the provider re-seat the ChatGPT accounts
 * live under instance integrations (`openai.main`, `openai.alternate`), so
 * the bare integration read finds nothing; the instances are discovered
 * from the merged config, never hardcoded. A config that cannot be read
 * answers none and is logged, mirroring readDisabledQuotaProviderIds.
 */
const readCodexInstanceIds = (): string[] => {
  try {
    const config = readConfig();
    const ids: string[] = [];
    for (const sectionKey of ['providers', 'provider']) {
      const section = asObject(config[sectionKey]);
      if (!section) continue;
      for (const [id, definition] of Object.entries(section)) {
        const instanceOf = asNonEmptyString(asObject(definition)?.instanceOf);
        if (instanceOf && CODEX_AUTH_ALIASES.includes(instanceOf)) ids.push(id);
      }
    }
    return ids;
  } catch (error) {
    console.warn('Quota: failed to read the OpenCode config; Codex instance credentials are not considered.', error);
    return [];
  }
};

const codexEntryWithToken = (auth: AuthFile, aliases: string[]) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases)) as Record<string, unknown> | null;
  return entry && accessOrTokenFrom(entry) ? entry : null;
};

/**
 * The credential the Codex fetch uses: the bare integration's entry, or —
 * when the re-seat left the bare integration empty — the first usable
 * instance entry. The VS Code surface answers a single result, so one
 * account serves it; the web surface folds every instance into the base
 * row. Mirrors packages/web/server/lib/quota/providers/codex.js (kept in
 * sync per the quota DOCUMENTATION.md parity note).
 */
const resolveCodexEntry = (auth: AuthFile) => {
  const direct = codexEntryWithToken(auth, CODEX_AUTH_ALIASES);
  if (direct) return direct;
  for (const instanceId of readCodexInstanceIds()) {
    const entry = codexEntryWithToken(auth, [instanceId]);
    if (entry) return entry;
  }
  return null;
};

/**
 * Providers with a usable credential. Throws when OpenCode's credentials
 * cannot be read, so a transient failure does not look like "nothing
 * configured".
 *
 * Providers turned off in OpenCode's config (`disabled_providers`) are left
 * out unless `includeDisabled` is set. Fetching one by name always works:
 * the filter governs the listing, never an explicit ask.
 */
export const listConfiguredQuotaProviders = async ({ includeDisabled = false }: { includeDisabled?: boolean } = {}) => {
  const auth = await readOpenCodeCredentials();
  const configured = new Set<string>();
  if (openCodeGoApiKey(auth) || openCodeGoConsoleCredential(auth)) configured.add('opencode-go');
  if (readCredential('cursor')) configured.add('cursor');
  if (readCredential('exe-dev')) configured.add('exe-dev');
  if (readCredential('opendesign')) configured.add('opendesign');

  // Ollama Cloud reads its key from OpenCode's credential store, so it is
  // configured exactly when that integration has a key.
  const ollamaAuth = normalizeAuthEntry(getAuthEntry(auth, ['ollama-cloud', 'ollamacloud']));
  if (ollamaApiKeyFrom(ollamaAuth)) {
    configured.add('ollama-cloud');
  }

  const anthropicAuth = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude']));
  if (accessOrTokenFrom(anthropicAuth)) {
    configured.add('claude');
  }

  if (resolveCodexEntry(auth)) {
    configured.add('codex');
  }

  if (resolveGeminiCliAuth(auth)) {
    configured.add('google');
  }
  if (resolveAntigravityAuth() || resolveAntigravityStoreAuth(auth)) {
    configured.add('antigravity');
  }

  const zaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai']));
  if (keyOrTokenFrom(zaiAuth)) {
    configured.add('zai-coding-plan');
  }

  const zhipuaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan']));
  if (keyOrTokenFrom(zhipuaiAuth)) {
    configured.add('zhipuai-coding-plan');
  }

  if (getKimiApiKey(auth)) {
    configured.add('kimi-for-coding');
  }

  const metaAuth = normalizeAuthEntry(getAuthEntry(auth, ['meta']));
  if (metaAuth && (asNonEmptyString(metaAuth.key) || asNonEmptyString(metaAuth.token) || asNonEmptyString(metaAuth.access))) {
    configured.add('meta');
  }

  const mistralAuth = normalizeAuthEntry(getAuthEntry(auth, ['mistral']));
  if (mistralAuth && (asNonEmptyString(mistralAuth.key) || asNonEmptyString(mistralAuth.token) || asNonEmptyString(mistralAuth.access))) {
    configured.add('mistral');
  }

  if (commandCodeApiKey(auth)) {
    configured.add('command-code');
  }

  const minimaxAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-coding-plan']));
  if (keyOrTokenFrom(minimaxAuth)) {
    configured.add('minimax-coding-plan');
  }

  const minimaxCnAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-cn-coding-plan']));
  if (keyOrTokenFrom(minimaxCnAuth)) {
    configured.add('minimax-cn-coding-plan');
  }

  const openrouterAuth = normalizeAuthEntry(getAuthEntry(auth, ['openrouter']));
  if (keyOrTokenFrom(openrouterAuth)) {
    configured.add('openrouter');
  }

  const nanopgAuth = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt']));
  if (keyOrTokenFrom(nanopgAuth)) {
    configured.add('nano-gpt');
  }

  const copilotAuth = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot']));
  if (accessOrTokenFrom(copilotAuth)) {
    configured.add('github-copilot');
  }


  const waferAuth = normalizeAuthEntry(getAuthEntry(auth, ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai']));
  if (keyOrTokenFrom(waferAuth)) {
    configured.add('wafer');
  }

  const clineAuth = normalizeAuthEntry(getAuthEntry(auth, ['cline-pass']));
  if (clineAuth && (asNonEmptyString(clineAuth.key) || asNonEmptyString(clineAuth.token))) {
    configured.add('cline-pass');
  }

  const neuralwattAuth = normalizeAuthEntry(getAuthEntry(auth, ['neuralwatt']));
  if (keyOrTokenFrom(neuralwattAuth)) {
    configured.add('neuralwatt');
  }

  const deepseekAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepseek']));
  if (keyOrTokenFrom(deepseekAuth)) {
    configured.add('deepseek');
  }

  const deepinfraAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepinfra', 'deep-infra', 'deep_infra']));
  if (keyOrTokenFrom(deepinfraAuth)) {
    configured.add('deepinfra');
  }

  if (getHyperApiKey(auth)) {
    configured.add('hyper');
  }

  if (asNonEmptyString(readCredential('zenmux')?.platformApiKey)) {
    configured.add('zenmux');
  }

  if (getKiloApiKey(auth)) {
    configured.add('kilo');
  }

  if (resolveXaiAuth(auth)) {
    configured.add('xai');
  }

  if (!includeDisabled) {
    const disabled = readDisabledQuotaProviderIds();
    for (const id of disabled) {
      configured.delete(id);
    }
  }

  return Array.from(configured);
};

// A 401 is not always an expired token: the usage endpoint refuses OpenCode's
// `chatgpt-token-sharing` token with an access-enforcement body, and OpenAI has
// no usage endpoint for that sign-in. Same wording as the web server's Codex provider.
const codexErrorBodySchema = z.object({ error: z.object({ type: z.string() }) });

const codexUnauthorizedMessage = async (response: Response): Promise<string> => {
  const body = codexErrorBodySchema.safeParse(await readQuotaJson(response).catch(() => null));
  return body.success && body.data.error.type === 'rejected_by_access_enforcement'
    ? 'OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.'
    : 'Session expired \u2014 please re-authenticate with OpenAI';
};

// The usage endpoint passes its own computed percentages through, and a spend
// control or an exhausted overage can arrive outside 0-100. Clamp both bounds
// like the Copilot and Ollama Cloud paths, and keep an absent value absent.
const toCodexUsedPercent = (value: number | string | null | undefined): number | null => {
  const percent = toNumber(value);
  return percent === null ? null : clampPercent(percent);
};

type CodexQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchCodexQuota = async ({ readAuth = readOpenCodeCredentials }: CodexQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = resolveCodexEntry(auth);
  const accessToken = accessOrTokenFrom(entry);
  const accountId = entry?.accountId as string | undefined;

  if (!accessToken) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'codex',
        providerName: 'Codex',
        ok: false,
        configured: true,
        error: response.status === 401 ? await codexUnauthorizedMessage(response) : `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as OpenAiUsagePayload;
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows: Record<string, UsageWindow> = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toCodexUsedPercent(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at),
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toCodexUsedPercent(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at),
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const valueLabel = unlimited
        ? 'Unlimited'
        : balance !== null
          ? String(balance)
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      });
    }
    if (payload?.spend_control?.individual_limit) {
      const spendLimit = payload.spend_control.individual_limit;
      const used = toNumber(spendLimit.used);
      const limit = toNumber(spendLimit.limit);
      const valueLabel = used !== null && limit !== null
        ? `${used.toFixed(0)} / ${limit.toFixed(0)} used`
        : null;
      windows.credits = toUsageWindow({
        usedPercent: toCodexUsedPercent(spendLimit.used_percent),
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      });
    }

    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

type GoogleAuthSource = {
  sourceId: 'gemini' | 'antigravity';
  sourceLabel: string;
  accessToken?: string;
  refreshToken?: string;
  expires?: number;
  projectId?: string;
  email?: string;
};

const resolveGeminiCliAuth = (auth: AuthFile): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth'])) as Record<string, unknown> | null;
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken: accessToken ?? undefined,
    refreshToken: refreshParts.refreshToken ?? undefined,
    projectId: (refreshParts.projectId ?? refreshParts.managedProjectId) ?? undefined,
    expires: toTimestamp(oauthObject.expires) ?? undefined,
  };
};

const resolveAntigravityAuth = (): GoogleAuthSource | null => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const index = typeof (data as Record<string, unknown>)?.activeIndex === 'number'
        ? (data as Record<string, unknown>).activeIndex as number
        : 0;
      const account = (accounts[index] as Record<string, unknown> | undefined) ?? (accounts[0] as Record<string, unknown> | undefined);
      if (account?.refreshToken) {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        if (!refreshParts.refreshToken) continue;
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId
            ?? undefined,
          email: asNonEmptyString(account.email) ?? undefined,
        };
      }
    }
  }

  return null;
};

/**
 * The Antigravity login OpenCode itself holds: the `google` integration's
 * OAuth credential in the credential store, written by the plugin's
 * `antigravity` auth method. Current plugin versions sign in through the
 * credential store and never write the legacy accounts file, so a store-only
 * sign-in must still read as configured here — the mirror of
 * `resolveAntigravityStoreAuth` in the web provider's auth module, which
 * PR #764 added there. The accounts file stays first choice; a `google`
 * entry that is an API key carries no refresh token and resolves to null.
 */
const resolveAntigravityStoreAuth = (auth: AuthFile): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);
  if (!refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'antigravity',
    sourceLabel: 'Antigravity',
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId ?? undefined,
  };
};

const resolveGoogleAuthSources = (auth: AuthFile): GoogleAuthSource[] => {
  const sources: GoogleAuthSource[] = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  return sources;
};

const fetchGoogleQuotaBuckets = async (accessToken: string, projectId?: string) => {
  const body = projectId ? { project: projectId } : {};
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
  try {
    const response = await fetch(`${GOOGLE_PRIMARY_ENDPOINT}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await readQuotaJson(response) as GoogleQuotaBucketsPayload;
  } catch {
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const fetchGoogleModels = async (
  accessToken: string,
  projectId?: string,
  endpoints: readonly string[] = GOOGLE_ENDPOINTS,
  clientHeaders: Record<string, string> = GOOGLE_HEADERS,
) => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of endpoints) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...clientHeaders,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (response.ok) {
        return await readQuotaJson(response) as Record<string, unknown>;
      }
    } catch {
      // fall through
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  return null;
};

const fetchGoogleQuota = async (): Promise<ProviderResult> => {
  const authSources = resolveGoogleAuthSources(await readOpenCodeCredentials());
  if (!authSources.length) {
    return buildResult({
      providerId: 'google',
      providerName: 'Google (Code Assist, per-model)',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const models: Record<string, ProviderUsage> = {};
  const sourceErrors: string[] = [];

  for (const source of authSources) {
    const now = Date.now();
    let accessToken = source.accessToken;

    if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
      if (!source.refreshToken) {
        sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
        continue;
      }
      const result = await refreshGoogleAccessToken(source.refreshToken, 'gemini', { fallbackToAntigravity: true });
      if (!result.ok) {
        sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
        continue;
      }
      accessToken = result.accessToken;
    }

    const projectId = source.projectId ?? DEFAULT_PROJECT_ID;
    let mergedAnyModel = false;

    if (source.sourceId === 'gemini') {
      const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

      for (const bucket of buckets) {
        const modelId = asNonEmptyString(bucket.modelId);
        if (!modelId) {
          continue;
        }

        const scopedName = modelId.startsWith(`${source.sourceId}/`)
          ? modelId
          : `${source.sourceId}/${modelId}`;

        const remainingFraction = toNumber(bucket.remainingFraction);
        const remainingPercent = remainingFraction !== null
          ? Math.round(remainingFraction * 100)
          : null;
        const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
        const resetAt = toTimestamp(bucket.resetTime);
        const window = resolveGoogleWindow(source.sourceId, resetAt);

        models[scopedName] = {
          windows: {
            [window.label]: toUsageWindow({
              usedPercent,
              windowSeconds: window.seconds,
              resetAt,
            }),
          },
        };
        mergedAnyModel = true;
      }
    }

    const payload = await fetchGoogleModels(accessToken, projectId);
    if (payload && typeof payload === 'object') {
      const payloadModels = (payload as GoogleModelsPayload).models ?? {};
      for (const [modelName, modelData] of Object.entries(payloadModels)) {
        const scopedName = modelName.startsWith(`${source.sourceId}/`)
          ? modelName
          : `${source.sourceId}/${modelName}`;
        const quotaInfo = modelData?.quotaInfo;
        const remainingFraction = quotaInfo?.remainingFraction;
        const remainingPercent = typeof remainingFraction === 'number'
          ? Math.round(remainingFraction * 100)
          : null;
        const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
        const resetAt = toTimestamp(quotaInfo?.resetTime);
        const window = resolveGoogleWindow(source.sourceId, resetAt);
        models[scopedName] = {
          windows: {
            [window.label]: toUsageWindow({
              usedPercent,
              windowSeconds: window.seconds,
              resetAt,
            }),
          },
        };
        mergedAnyModel = true;
      }
    }

    if (!mergedAnyModel) {
      sourceErrors.push(`${source.sourceLabel}: Failed to fetch models`);
    }
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId: 'google',
      providerName: 'Google (Code Assist, per-model)',
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models',
    });
  }

  return buildResult({
    providerId: 'google',
    providerName: 'Google (Code Assist, per-model)',
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined,
    },
  });
};

type QuotaSummaryBucketPayload = {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  displayName?: string;
};

type QuotaSummaryGroupPayload = {
  displayName?: string;
  buckets?: QuotaSummaryBucketPayload[];
};

type QuotaSummaryPayload = {
  groups?: QuotaSummaryGroupPayload[];
};

const fetchAntigravityQuotaSummary = async (accessToken: string, projectId?: string): Promise<QuotaSummaryPayload | null> => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...antigravityHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (response.ok) {
        return await readQuotaJson(response) as QuotaSummaryPayload;
      }
    } catch {
      // fall through
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  return null;
};

const fetchAntigravityQuota = async (): Promise<ProviderResult> => {
  let auth = resolveAntigravityAuth();
  let authFromStore = false;
  if (!auth) {
    let storeReadFailed = false;
    try {
      auth = resolveAntigravityStoreAuth(await readOpenCodeCredentials());
      authFromStore = auth !== null;
    } catch {
      storeReadFailed = true;
    }
    if (!auth && storeReadFailed) {
      // A store that could not be read has not answered "no login": for a
      // store-only sign-in this is a failed refresh, not a missing login,
      // and reporting Not configured would clear the quota view of a
      // provider that is configured. (The web provider keeps the same
      // distinction in its candidate resolution.)
      return buildResult({
        providerId: 'antigravity',
        providerName: 'Antigravity',
        ok: false,
        configured: true,
        error: 'Failed to read OpenCode credentials',
      });
    }
  }
  if (!auth || !auth.refreshToken) {
    return buildResult({
      providerId: 'antigravity',
      providerName: 'Antigravity',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const result = await refreshGoogleAccessToken(auth.refreshToken, 'antigravity');
  // Mirror of the web provider's wrong-client handling: a store login
  // carries no reliable marker of its issuing client, so when the token
  // endpoint confirms the refresh token was not issued to the
  // Antigravity client (HTTP 400/401, `unauthorized_client`) the login
  // is another client's (a Gemini CLI OAuth sign-in) - there is no
  // Antigravity source, so report not configured instead of a permanent
  // refresh failure. An accounts-file login is Antigravity-issued by
  // construction and keeps the failure state.
  if (!result.ok && authFromStore && result.error === 'unauthorized_client' && (result.status === 400 || result.status === 401)) {
    return buildResult({
      providerId: 'antigravity',
      providerName: 'Antigravity',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }
  const accessToken = result.ok ? result.accessToken : null;
  if (!accessToken) {
    return buildResult({
      providerId: 'antigravity',
      providerName: 'Antigravity',
      ok: false,
      configured: true,
      error: 'Failed to refresh Antigravity token',
    });
  }

  const projectId = auth.projectId ?? DEFAULT_PROJECT_ID;

  const [summaryPayload, rawModelsPayload] = await Promise.all([
    fetchAntigravityQuotaSummary(accessToken, projectId),
    fetchGoogleModels(accessToken, projectId, ANTIGRAVITY_ENDPOINTS, antigravityHeaders()),
  ]);

  warnIfGeminiGroupMissing(summaryPayload);

  const modelGroupWindows: Array<{
    groupType: 'gemini' | '3p';
    windows: Record<string, UsageWindow>;
    bucket5h?: { remainingFraction: number };
    bucketWeekly?: { remainingFraction: number };
  }> = [];

  const groups = summaryPayload?.groups ?? [];
  for (const group of groups) {
    const groupName = (group.displayName ?? '').toLowerCase();
    const is3p = groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p');
    const groupType: 'gemini' | '3p' = is3p ? '3p' : 'gemini';

    const windows: Record<string, UsageWindow> = {};
    let bucket5h: { remainingFraction: number } | undefined;
    let bucketWeekly: { remainingFraction: number } | undefined;

    for (const b of group.buckets ?? []) {
      const remainingFraction = toNumber(b.remainingFraction);
      const remainingPercent = remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
      const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
      const resetAt = toTimestamp(b.resetTime);
      const windowStr = (b.window ?? b.bucketId ?? '').toLowerCase();

      let label = '5h';
      let seconds = GOOGLE_FIVE_HOUR_WINDOW_SECONDS;

      if (windowStr.includes('week') || windowStr.includes('7d')) {
        label = 'weekly';
        seconds = GOOGLE_WEEKLY_WINDOW_SECONDS;
        bucketWeekly = { remainingFraction: remainingFraction ?? 1 };
      } else if (windowStr.includes('day') || windowStr.includes('daily')) {
        label = 'daily';
        seconds = GOOGLE_DAILY_WINDOW_SECONDS;
      } else {
        label = '5h';
        seconds = GOOGLE_FIVE_HOUR_WINDOW_SECONDS;
        bucket5h = { remainingFraction: remainingFraction ?? 1 };
      }

      windows[label] = toUsageWindow({
        usedPercent,
        windowSeconds: seconds,
        resetAt,
      });
    }

    modelGroupWindows.push({
      groupType,
      windows,
      bucket5h,
      bucketWeekly,
    });
  }

  const models: Record<string, ProviderUsage> = {};
  const rawModels = (rawModelsPayload as GoogleModelsPayload)?.models ?? {};

  for (const [modelName, modelData] of Object.entries(rawModels)) {
    const name = asNonEmptyString(modelName);
    if (!name) continue;

    const lowerName = name.toLowerCase();
    const is3p = lowerName.includes('claude') || lowerName.includes('gpt');
    const matchedGroup = modelGroupWindows.find((g) => is3p ? g.groupType === '3p' : g.groupType === 'gemini');

    if (matchedGroup && Object.keys(matchedGroup.windows).length > 0) {
      const isWeeklyConstrained = matchedGroup.bucketWeekly
        && (matchedGroup.bucketWeekly.remainingFraction <= 0.001
          || (matchedGroup.bucket5h && matchedGroup.bucketWeekly.remainingFraction < matchedGroup.bucket5h.remainingFraction));

      const reorderedWindows: Record<string, UsageWindow> = {};
      if (isWeeklyConstrained && matchedGroup.windows.weekly) {
        reorderedWindows.weekly = matchedGroup.windows.weekly;
        if (matchedGroup.windows['5h']) {
          reorderedWindows['5h'] = matchedGroup.windows['5h'];
        }
      } else {
        if (matchedGroup.windows['5h']) {
          reorderedWindows['5h'] = matchedGroup.windows['5h'];
        }
        if (matchedGroup.windows.weekly) {
          reorderedWindows.weekly = matchedGroup.windows.weekly;
        }
      }

      for (const [wLabel, wData] of Object.entries(matchedGroup.windows)) {
        if (!reorderedWindows[wLabel]) {
          reorderedWindows[wLabel] = wData;
        }
      }

      models[name] = { windows: reorderedWindows };
    } else {
      const quotaInfo = modelData?.quotaInfo;
      const remainingFraction = quotaInfo?.remainingFraction;
      const remainingPercent = typeof remainingFraction === 'number' ? Math.round(remainingFraction * 100) : null;
      const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
      const resetAt = toTimestamp(quotaInfo?.resetTime);
      const window = resolveGoogleWindow('antigravity', resetAt);

      models[name] = {
        windows: {
          [window.label]: toUsageWindow({
            usedPercent,
            windowSeconds: window.seconds,
            resetAt,
          }),
        },
      };
    }
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId: 'antigravity',
      providerName: 'Antigravity',
      ok: false,
      configured: true,
      error: 'Failed to fetch Antigravity quota',
    });
  }

  return buildResult({
    providerId: 'antigravity',
    providerName: 'Antigravity',
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined,
    },
  });
};

const CLAUDE_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const CLAUDE_MAX_COOLDOWN_MS = 60 * 60 * 1000;
let claudeCredentialFingerprint: string | null = null;
let claudeCachedUsage: ProviderUsage | null = null;
let claudeCooldownUntil = 0;

const claudeCooldownFromResponse = (response: Response): number => {
  const raw = response.headers.get('retry-after');
  const seconds = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, CLAUDE_MAX_COOLDOWN_MS);
  }
  if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return Math.min(retryAt - Date.now(), CLAUDE_MAX_COOLDOWN_MS);
    }
  }
  return CLAUDE_DEFAULT_COOLDOWN_MS;
};

const buildClaudeRateLimitResult = (): ProviderResult => (
  claudeCachedUsage
    ? buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: true,
        configured: true,
        usage: claudeCachedUsage,
      })
    : buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Rate limited. Retrying soon.',
      })
);

const buildClaudeUsage = (payload: Record<string, unknown>): ProviderUsage => {
  const windows: Record<string, UsageWindow> = {};
  const models: Record<string, ProviderUsage> = {};
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const clampClaudeUsedPercent = (percent: number | null): number | null => {
    return percent === null ? null : clampPercent(percent);
  };

  for (const entry of limits) {
    const limit = asObject(entry);
    if (!limit) continue;
    const usedPercent = clampClaudeUsedPercent(toNumber(limit.percent));
    const resetAt = toTimestamp(limit.resets_at);
    if (limit.kind === 'session') {
      windows['5h'] = toUsageWindow({ usedPercent, windowSeconds: 5 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_all') {
      windows['7d'] = toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_scoped') {
      const modelName = asNonEmptyString(asObject(asObject(limit.scope)?.model)?.display_name);
      if (modelName) {
        models[modelName] = {
          windows: {
            '7d': toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt }),
          },
        };
      }
    }
  }

  if (!limits.length) {
    const fiveHour = asObject(payload.five_hour);
    const sevenDay = asObject(payload.seven_day);
    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: clampClaudeUsedPercent(toNumber(fiveHour.utilization)),
        windowSeconds: 5 * 60 * 60,
        resetAt: toTimestamp(fiveHour.resets_at),
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: clampClaudeUsedPercent(toNumber(sevenDay.utilization)),
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: toTimestamp(sevenDay.resets_at),
      });
    }
  }

  const spend = asObject(payload.spend);
  if (spend?.enabled === true) {
    const usedMoney = asObject(spend.used);
    const limitMoney = asObject(spend.limit);
    const usedMinor = toNumber(usedMoney?.amount_minor);
    const limitMinor = toNumber(limitMoney?.amount_minor);
    const exponent = toNumber(usedMoney?.exponent) ?? 2;
    const currency = asNonEmptyString(usedMoney?.currency);
    const prefix = currency === 'USD' || !currency ? '$' : `${currency} `;
    const used = usedMinor === null ? null : usedMinor / 10 ** exponent;
    const limit = limitMinor === null ? null : limitMinor / 10 ** (toNumber(limitMoney?.exponent) ?? 2);
    windows.extra_usage = toUsageWindow({
      usedPercent: clampClaudeUsedPercent(toNumber(spend.percent)),
      windowSeconds: null,
      resetAt: null,
      valueLabel: used === null ? null : `${prefix}${formatMoney(used)}${limit === null ? '' : ` / ${prefix}${formatMoney(limit)}`}`,
    });
  }

  return Object.keys(models).length ? { windows, models } : { windows };
};

type ClaudeQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchClaudeQuota = async ({ readAuth = readOpenCodeCredentials }: ClaudeQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude'])) as Record<string, unknown> | null;
  const accessToken = accessOrTokenFrom(entry);

  if (!accessToken) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const refreshToken = typeof entry?.refresh === 'string' ? entry.refresh : '';
  const fingerprint = `${accessToken}\0${refreshToken}`;
  if (claudeCredentialFingerprint !== fingerprint) {
    claudeCredentialFingerprint = fingerprint;
    claudeCachedUsage = null;
    claudeCooldownUntil = 0;
  }
  if (Date.now() < claudeCooldownUntil) return buildClaudeRateLimitResult();

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (response.status === 429) {
      claudeCooldownUntil = Date.now() + claudeCooldownFromResponse(response);
      return buildClaudeRateLimitResult();
    }

    if (response.status === 401 || response.status === 403) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Claude session expired. Open Claude Code to sign in again.',
      });
    }

    if (!response.ok) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as Record<string, unknown>;
    const usage = buildClaudeUsage(payload);
    claudeCachedUsage = usage;
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage,
    });
  } catch (error) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const buildCopilotWindows = (payload: Record<string, unknown>) => {
  const quota = (payload.quota_snapshots as Record<string, unknown>) ?? {};
  const resetAt = toTimestamp(payload.quota_reset_date);
  const windows: Record<string, UsageWindow> = {};

  // Mirrors the quota semantics of microsoft/vscode-copilot-chat
  // (CopilotUserQuotaInfo): each snapshot carries entitlement, remaining,
  // unlimited, and percent_remaining. Unlimited plans report no usable
  // entitlement; percent_remaining is a server-computed fallback.
  // `usedPercent` is computed from remaining/entitlement, and the value label
  // derives its credits from the same `entitlement - quota_remaining` axis
  // GitHub's own Copilot panel uses, so the percent and the label agree.
  // Premium interactions are credits rather than requests, and the endpoint
  // reports them fractionally (`quota_remaining: 39078.5`), so the label keeps
  // one decimal like GitHub's own panel ("20,836.9 / 60,000 used") instead of
  // rounding the half credit away.
  const formatCopilotCredits = (value: number): string => {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded)
      ? rounded.toLocaleString('en-US')
      : rounded.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  };

  const addWindow = (label: string, snapshot?: Record<string, unknown>) => {
    if (!snapshot) return;

    if (snapshot.unlimited === true) {
      windows[label] = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt,
        valueLabel: 'Unlimited',
      });
      return;
    }

    const entitlement = toNumber(snapshot.entitlement);
    // `quota_remaining` is the precise twin of `remaining`: the endpoint sends it
    // with one decimal (39078.5) and truncates it into `remaining` (39078).
    // GitHub's own Copilot panel reports the used figure as
    // `entitlement - quota_remaining` (60,000 - 39,078.5 = 20,921.5 used),
    // so prefer it and fall back to the integer twin.
    const remaining = toNumber(snapshot.quota_remaining) ?? toNumber(snapshot.remaining);
    let usedPercent = entitlement !== null && entitlement > 0 && remaining !== null
      ? Math.min(100, Math.max(0, 100 - (remaining / entitlement) * 100))
      : null;
    if (usedPercent === null) {
      const percentRemaining = toNumber(snapshot.percent_remaining);
      if (percentRemaining !== null) {
        usedPercent = Math.min(100, Math.max(0, 100 - percentRemaining));
      }
    }
    // `remaining` reports the axis opposite to everything else the quota UI
    // renders (the percent above, the progress bar, the used/remaining toggle),
    // so the old `remaining / entitlement left` label made OpenChamber state the
    // opposite of GitHub's own Copilot panel for the same account. VS Code and
    // GitHub both report `entitlement - quota_remaining` spent, so the label
    // uses that axis and keeps the fractional credit rather than rounding it
    // away, which also keeps it stable across the two twin fields.
    const used = entitlement === null || entitlement <= 0
      ? null
      : remaining !== null
        ? Math.max(0, Math.min(entitlement, entitlement - remaining))
        : null;
    const valueLabel = used === null || entitlement === null
      ? null
      : `${formatCopilotCredits(used)} / ${formatCopilotCredits(entitlement)} used`;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel,
    });
  };

  addWindow('premium_interactions', quota.premium_interactions as Record<string, unknown> | undefined);

  return windows;
};

const INVALID_COPILOT_ENTERPRISE_URL = 'Invalid GitHub Copilot Enterprise URL';

// A Copilot login on GitHub Enterprise Server carries `enterpriseUrl`, and that
// server hosts its own quota endpoint. Only a bare origin with a plausible DNS
// hostname is accepted, so a value that is not a usable host is refused here
// rather than turned into a request that carries the credential.
const COPILOT_ENTERPRISE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const copilotUserUrl = (enterpriseUrl: string | undefined): string => {
  const host = `${enterpriseUrl ?? ''}`.trim();
  if (!host) return 'https://api.github.com/copilot_internal/user';

  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(INVALID_COPILOT_ENTERPRISE_URL);
  if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(INVALID_COPILOT_ENTERPRISE_URL);
  }
  if (!COPILOT_ENTERPRISE_HOST.test(url.hostname)) throw new Error(INVALID_COPILOT_ENTERPRISE_URL);

  return `https://api.${url.hostname}/copilot_internal/user`;
};

type CopilotQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchCopilotQuota = async ({ readAuth = readOpenCodeCredentials }: CopilotQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot'])) as Record<string, unknown> | null;
  const accessToken = accessOrTokenFrom(entry);
  // SAFETY: OpenCode stores `enterpriseUrl` on a Copilot credential as a string when the
  // login targets GitHub Enterprise Server. A value that is not a usable host is refused by
  // `copilotUserUrl` before any request is made, so it cannot redirect the credential.
  const enterpriseUrl = entry?.enterpriseUrl as string | undefined;

  if (!accessToken) {
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch(copilotUserUrl(enterpriseUrl), {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as Record<string, unknown>;
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) },
    });
  } catch (error) {
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// The pre-ratio payload: one counted weekly `usage` block plus `limits[]`
// rate-limit entries. Plans that have not migrated still answer this way. Its
// `usage` block reports `used`; the `limits[].detail` blocks report `remaining`
// instead. Neither field is guaranteed present, so derive usedPercent from
// whichever one the API actually returned.
const computeKimiUsedPercent = (
  total: number | null,
  used: number | null,
  remaining: number | null,
): number | null => {
  if (!total) return null;
  if (used !== null) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  if (remaining !== null) {
    return Math.max(0, Math.min(100, 100 - (remaining / total) * 100));
  }
  return null;
};

// The ratio-based `usages` block, in the order Kimi's own CLI renders it.
// `limit_month_code` is not read: it is the code-typed share of
// `limit_month_total`, not a second allowance, and a value label carrying it
// would replace the monthly percent and stay a used figure when the panel shows
// what remains. `limit_7d` arrives only on plans that still have a weekly
// quota, and Kimi documents the client as rendering whichever entries are served.
type KimiRatioWindow = { key: string; label: string; windowSeconds: number | null };

const KIMI_RATIO_WINDOWS: KimiRatioWindow[] = [
  { key: 'limit_5h', label: '5h', windowSeconds: 5 * 60 * 60 },
  { key: 'limit_7d', label: 'weekly', windowSeconds: 7 * 24 * 60 * 60 },
  { key: 'limit_month_total', label: 'monthly', windowSeconds: null },
];

// `used_ratio` is a 0-1 fraction. An entry without a finite ratio carries no
// information, so it is skipped rather than shown as an unknown percentage.
const toKimiRatioPercent = (entry: Record<string, unknown> | null): number | null => {
  const ratio = toNumber(entry?.used_ratio);
  return ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
};

const kimiRatioWindows = (usages: Record<string, unknown>) => {
  const windows: Record<string, UsageWindow> = {};
  for (const { key, label, windowSeconds } of KIMI_RATIO_WINDOWS) {
    const entry = asObject(usages[key]);
    if (!entry) continue;
    const usedPercent = toKimiRatioPercent(entry);
    if (usedPercent === null) continue;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt: toTimestamp(entry.reset_time),
    });
  }
  return windows;
};

const kimiLegacyWindows = (payload: Record<string, unknown> | null) => {
  const windows: Record<string, UsageWindow> = {};
  const usage = asObject(payload?.usage);
  if (usage) {
    windows.weekly = toUsageWindow({
      usedPercent: computeKimiUsedPercent(toNumber(usage.limit), toNumber(usage.used), toNumber(usage.remaining)),
      windowSeconds: null,
      resetAt: toTimestamp(usage.resetTime),
    });
  }

  const rawLimits = payload?.limits;
  const limits = Array.isArray(rawLimits) ? rawLimits : [];
  for (const raw of limits) {
    const limit = asObject(raw);
    const window = asObject(limit?.window);
    const detail = asObject(limit?.detail);
    const duration = toNumber(window?.duration) ?? undefined;
    const timeUnit = asNonEmptyString(window?.timeUnit) ?? undefined;
    const rawLabel = durationToLabel(duration, timeUnit);
    const windowSeconds = durationToSeconds(duration, timeUnit);
    const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel;
    windows[label] = toUsageWindow({
      usedPercent: computeKimiUsedPercent(toNumber(detail?.limit), toNumber(detail?.used), toNumber(detail?.remaining)),
      windowSeconds,
      resetAt: toTimestamp(detail?.resetTime),
    });
  }
  return windows;
};

type KimiQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

const MOONSHOT_BALANCE_URL = 'https://api.moonshot.ai/v1/users/me/balance';

type MoonshotBalancePayload = {
  data?: { available_balance?: number };
};

// Mirrors packages/web/server/lib/quota/providers/kimi.js: a pay-as-you-go Moonshot
// platform key is refused by the Kimi Code usage address, so its balance is read instead.
// Returns the credits_balance windows, or null when they cannot be read.
const fetchMoonshotBalanceWindows = async (
  apiKey: string,
  fetchImpl: (url: string, options: RequestInit) => Promise<Response>,
): Promise<Record<string, UsageWindow> | null> => {
  try {
    const response = await fetchImpl(MOONSHOT_BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const balance = (await readQuotaJson(response) as MoonshotBalancePayload)?.data?.available_balance;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) return null;
    return {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance)}`,
      }),
    };
  } catch {
    return null;
  }
};

export const fetchKimiQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: KimiQuotaDependencies = {}): Promise<ProviderResult> => {
  const apiKey = getKimiApiKey(await readAuth());

  if (!apiKey) {
    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetchImpl('https://api.kimi.com/coding/v1/usages', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const balanceWindows = await fetchMoonshotBalanceWindows(apiKey, fetchImpl);
        if (balanceWindows) {
          return buildResult({
            providerId: 'kimi-for-coding',
            providerName: 'Kimi for Coding',
            ok: true,
            configured: true,
            usage: { windows: balanceWindows },
          });
        }
      }
      return buildResult({
        providerId: 'kimi-for-coding',
        providerName: 'Kimi for Coding',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = asObject(await readQuotaJson(response));
    // Kimi replaced the counted payload with a ratio-based `usages` map. Its own
    // client reads only `usages`, so when that block is present the `limits[]`
    // entry for the same 5-hour window is a coarser duplicate and is not read.
    const usages = asObject(payload?.usages);
    const windows = usages ? kimiRatioWindows(usages) : kimiLegacyWindows(payload);

    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const fetchMiniMaxQuota = async (data: {
  providerId: 'minimax-coding-plan' | 'minimax-cn-coding-plan';
  providerName: string;
  endpoint: string;
  usageFieldsAreRemaining: boolean;
}): Promise<ProviderResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, [data.providerId])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch(data.endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as Record<string, unknown>;
    const baseResp = asObject(payload.base_resp);
    const statusCode = toNumber(baseResp?.status_code);
    if (baseResp && statusCode !== 0) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: asNonEmptyString(baseResp.status_msg) ?? `API error: ${statusCode}`,
      });
    }

    const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : [];
    const firstModel = asObject(modelRemains[0]);
    if (!firstModel) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: 'No model quota data available',
      });
    }

    const intervalTotal = toNumber(firstModel.current_interval_total_count);
    const intervalUsage = toNumber(firstModel.current_interval_usage_count);
    const intervalStartAt = toTimestamp(firstModel.start_time);
    const intervalResetAt = toTimestamp(firstModel.end_time);
    const weeklyTotal = toNumber(firstModel.current_weekly_total_count);
    const weeklyUsage = toNumber(firstModel.current_weekly_usage_count);
    const weeklyStartAt = toTimestamp(firstModel.weekly_start_time);
    const weeklyResetAt = toTimestamp(firstModel.weekly_end_time);

    const intervalUsed = data.usageFieldsAreRemaining && intervalTotal !== null && intervalUsage !== null
      ? intervalTotal - intervalUsage
      : intervalUsage;
    const weeklyUsed = data.usageFieldsAreRemaining && weeklyTotal !== null && weeklyUsage !== null
      ? weeklyTotal - weeklyUsage
      : weeklyUsage;

    const intervalUsedPercent = intervalTotal !== null && intervalTotal > 0 && intervalUsed !== null
      ? Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100))
      : null;
    const intervalWindowSeconds = intervalStartAt && intervalResetAt && intervalResetAt > intervalStartAt
      ? Math.floor((intervalResetAt - intervalStartAt) / 1000)
      : null;
    const weeklyUsedPercent = weeklyTotal !== null && weeklyTotal > 0 && weeklyUsed !== null
      ? Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100))
      : null;
    const weeklyWindowSeconds = weeklyStartAt && weeklyResetAt && weeklyResetAt > weeklyStartAt
      ? Math.floor((weeklyResetAt - weeklyStartAt) / 1000)
      : null;

    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          '5h': toUsageWindow({
            usedPercent: intervalUsedPercent,
            windowSeconds: intervalWindowSeconds,
            resetAt: intervalResetAt,
          }),
          weekly: toUsageWindow({
            usedPercent: weeklyUsedPercent,
            windowSeconds: weeklyWindowSeconds,
            resetAt: weeklyResetAt,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const fetchMiniMaxCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-coding-plan',
  providerName: 'MiniMax Coding Plan (minimax.io)',
  endpoint: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: false,
});

const fetchMiniMaxCnCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-cn-coding-plan',
  providerName: 'MiniMax Coding Plan (minimaxi.com)',
  endpoint: 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: true,
});

/** The active account's Ollama Cloud API key, the same one chat requests use. */
const readOllamaCloudApiKey = async (): Promise<string | undefined> => {
  const entry = normalizeAuthEntry(getAuthEntry(await readOpenCodeCredentials(), ['ollama-cloud', 'ollamacloud']));
  return ollamaApiKeyFrom(entry) ?? undefined;
};

const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance';
const OLLAMA_ME_URL = 'https://ollama.com/api/me';

/**
 * The account's credit pool, mirroring `toUsageWindows` in the web server's
 * `quota/providers/ollama-cloud.js`.
 */
const fetchOllamaCloudUsage = async (
  apiKey: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Record<string, UsageWindow>> => {
  const response = await fetchImpl(OLLAMA_BALANCE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Ollama Cloud authentication failed');
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);

  const payload = asObject(await readQuotaJson(response));
  const included = asObject(payload?.included);
  const allowance = toNumber(included?.allowance_usd);
  const remaining = toNumber(included?.balance_usd);
  const windows: Record<string, UsageWindow> = {};
  if (allowance !== null && allowance > 0 && remaining !== null) {
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, ((allowance - remaining) / allowance) * 100)),
      windowSeconds: null,
      resetAt: toTimestamp(asObject(included?.period)?.until),
    });
  }

  for (const name of ['session', 'weekly'] as const) {
    const limit = asObject(included?.[name]);
    const remainingPercent = toNumber(limit?.remaining_percent);
    if (remainingPercent === null) continue;
    windows[name] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, 100 - remainingPercent)),
      windowSeconds: null,
      resetAt: toTimestamp(limit?.resets_at),
    });
  }

  const purchased = toNumber(asObject(payload?.purchased)?.balance_usd);
  if (purchased !== null && purchased > 0) {
    windows.purchased_credits = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(purchased)}`,
    });
  }

  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

/** The plan tier ("free", "pro", "max"), best-effort: a failure drops the label, not the reading. */
const fetchOllamaCloudPlan = async (
  apiKey: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string | null> => {
  const response = await fetchImpl(OLLAMA_ME_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return asNonEmptyString(asObject(await readQuotaJson(response))?.Plan);
};

export const fetchOllamaCloudQuota = async ({
  readApiKey,
  fetchImpl = fetch,
}: {
  readApiKey?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
} = {}): Promise<ProviderResult> => {
  // The cookie this provider used to store is obsolete the first time we reach
  // for the key instead. Removed on the first refresh whether or not a key is
  // readable, so a user who only ever pasted a cookie never keeps a browser
  // session cookie on disk. Mirrors the web server's cleanup.
  deleteLegacyOllamaCloudCredential();

  const apiKey = await (readApiKey ?? readOllamaCloudApiKey)();

  if (!apiKey) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const [windows, plan] = await Promise.all([
      fetchOllamaCloudUsage(apiKey, fetchImpl),
      fetchOllamaCloudPlan(apiKey, fetchImpl).catch(() => null),
    ]);

    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: plan,
    });
  } catch (error) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const fetchExeDevQuota = async (): Promise<ProviderResult> => {
  const usageToken = readCredential('exe-dev')?.usageToken;
  if (!usageToken) return buildResult({ providerId: 'exe-dev', providerName: 'exe.dev', ok: false, configured: false, error: 'Not configured' });
  try {
    return buildResult({ providerId: 'exe-dev', providerName: 'exe.dev', ok: true, configured: true, usage: { windows: await fetchExeDevUsage(usageToken) } });
  } catch (error) {
    return buildResult({ providerId: 'exe-dev', providerName: 'exe.dev', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};

const CURSOR_BASE_URL = 'https://api2.cursor.sh';

const fetchCursorConnect = async (path: string, accessToken: string, body: Record<string, unknown> | null): Promise<Record<string, unknown>> => {
  const response = await fetch(`${CURSOR_BASE_URL}/${path}`, body === null
    ? { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) }
    : { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  return readQuotaJson(response) as Promise<Record<string, unknown>>;
};

const cursorRequestUsage = (authUsage: unknown): { used: number; limit: number } | null => {
  let best: { used: number; limit: number } | null = null;
  for (const [key, entry] of Object.entries((authUsage ?? {}) as Record<string, Record<string, unknown>>)) {
    if (key === 'startOfMonth' || !entry) continue;
    const used = toNumber(entry.numRequests);
    const limit = toNumber(entry.maxRequestUsage);
    if (used === null || !limit) continue;
    if (!best || limit > best.limit) best = { used, limit };
  }
  return best;
};

const cursorTeamMemberSpend = (teamSpend: unknown, userId: unknown): Record<string, unknown> | null => {
  const id = toNumber(userId);
  const members = (teamSpend as Record<string, unknown> | null | undefined)?.teamMemberSpend;
  if (id === null || !Array.isArray(members)) return null;
  return (members as Array<Record<string, unknown>>).find((member) => toNumber(member?.userId) === id) ?? null;
};

const cursorCreditsWindow = (credits: Record<string, unknown> | null): UsageWindow | null => {
  const balance = toNumber(credits?.balanceCents ?? credits?.totalBalanceCents ?? credits?.amountCents);
  return balance === null ? null : toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: `$${formatMoney(balance / 100)}` });
};

const cursorCycleMs = (value: unknown): number | null => normalizeTimestamp(toNumber(value)) ?? toTimestamp(value);

const cursorCycleWindowSeconds = (startValue: unknown, endValue: unknown): number | null => {
  const start = cursorCycleMs(startValue);
  const end = cursorCycleMs(endValue);
  return start !== null && end !== null && end > start ? Math.floor((end - start) / 1000) : null;
};

const cursorEnterpriseWindows = (usage: Record<string, unknown> | null, plan: Record<string, unknown> | null, authUsage: Record<string, unknown> | null, hardLimit: Record<string, unknown> | null, memberSpend: Record<string, unknown> | null): Record<string, UsageWindow> => {
  const planInfo = (plan?.planInfo as Record<string, unknown> | undefined);
  const resetAt = toTimestamp(planInfo?.billingCycleEnd ?? usage?.billingCycleEnd);
  const windowSeconds = cursorCycleWindowSeconds(planInfo?.billingCycleStart ?? usage?.billingCycleStart, planInfo?.billingCycleEnd ?? usage?.billingCycleEnd);
  const windows: Record<string, UsageWindow> = {};
  const requestUsage = cursorRequestUsage(authUsage);
  if (requestUsage) {
    windows.billing_cycle = toUsageWindow({ usedPercent: Math.min(100, Math.max(0, (requestUsage.used / requestUsage.limit) * 100)), windowSeconds, resetAt, valueLabel: `${Math.round(requestUsage.used)} / ${Math.round(requestUsage.limit)}` });
  }
  const limitDollars = toNumber(hardLimit?.hardLimitPerUser);
  const usedCents = toNumber(memberSpend?.spendCents);
  if (limitDollars !== null && limitDollars > 0 && usedCents !== null) {
    windows.on_demand = toUsageWindow({ usedPercent: Math.min(100, Math.max(0, (usedCents / (limitDollars * 100)) * 100)), windowSeconds, resetAt, valueLabel: `$${formatMoney(usedCents / 100)} / $${formatMoney(limitDollars)}` });
  }
  return windows;
};

const fetchCursorQuota = async (): Promise<ProviderResult> => {
  const accessToken = readCredential('cursor')?.accessToken;
  if (!accessToken) return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: false, error: 'Not configured' });
  try {
    const post = (path: string, body: Record<string, unknown> = {}) => fetchCursorConnect(path, accessToken, body);
    const get = (path: string) => fetchCursorConnect(path, accessToken, null);
    const [usage, plan, credits] = await Promise.all([
      post('aiserver.v1.DashboardService/GetCurrentPeriodUsage'),
      post('aiserver.v1.DashboardService/GetPlanInfo').catch(() => null),
      post('aiserver.v1.DashboardService/GetCreditGrantsBalance').catch(() => null),
    ]);
    if (usage?.enabled === false) return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: 'No active Cursor subscription' });
    if (!usage?.planUsage) {
      const profile = await get('auth/full_stripe_profile').catch(() => null);
      const teamId = profile?.teamId ? String(profile.teamId) : null;
      const teamBody = teamId ? { teamId } : {};
      const [authUsage, hardLimit, teamSpend, me] = await Promise.all([
        get('auth/usage').catch(() => null),
        post('aiserver.v1.DashboardService/GetHardLimit', teamBody).catch(() => null),
        teamId ? post('aiserver.v1.DashboardService/GetTeamSpend', teamBody).catch(() => null) : null,
        post('aiserver.v1.DashboardService/GetMe').catch(() => null),
      ]);
      const windows = cursorEnterpriseWindows(usage, plan, authUsage, hardLimit, cursorTeamMemberSpend(teamSpend, me?.userId));
      if (!windows.billing_cycle && !windows.on_demand) {
        return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: 'No active Cursor subscription' });
      }
      const creditWindow = cursorCreditsWindow(credits);
      if (creditWindow) windows.credits = creditWindow;
      const planName = (plan?.planInfo as Record<string, unknown> | undefined)?.planName;
      return buildResult({ providerId: 'cursor', providerName: planName ? `Cursor ${String(planName)}` : 'Cursor', ok: true, configured: true, usage: { windows } });
    }
    const planUsage = (usage.planUsage as Record<string, unknown> | undefined) ?? {};
    const rawUsedPercent = toNumber(planUsage.totalPercentUsed);
    const usedPercent = rawUsedPercent === null ? null : Math.min(100, Math.max(0, rawUsedPercent));
    return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: true, configured: true, usage: { windows: { billing_cycle: toUsageWindow({ usedPercent, windowSeconds: null, resetAt: toTimestamp(usage.billingCycleEnd) }) } } });
  } catch (error) { return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' }); }
};

const openRouterResetAt = (period: string | null, nowMs: number): number | null => {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (period === 'daily') return Date.UTC(year, month, day + 1);
  if (period === 'weekly') {
    const daysUntilMonday = ((8 - now.getUTCDay()) % 7) || 7;
    return Date.UTC(year, month, day + daysUntilMonday);
  }
  if (period === 'monthly') return Date.UTC(year, month + 1, 1);
  return null;
};

const PERIOD_SECONDS = { daily: 86400, weekly: 604800, monthly: 30 * 86400 };
type OpenRouterPeriod = keyof typeof PERIOD_SECONDS;

const isOpenRouterPeriod = (value: unknown): value is OpenRouterPeriod => (
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERIOD_SECONDS, value)
);

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

// The stored key is valid for whichever gateway the configured baseURL points
// at, so the usage lookup must ride the same base as chat. The endpoint shape
// stays `<base>/key`; with nothing configured the base is OpenRouter itself.
// OpenCode takes the address from `settings.baseURL`, legacy `options.baseURL`
// or legacy `api`, and toProviderEntity folds all three. Each section is read
// on its own so a v2 entry without an address cannot hide a v1 address that
// another config file sets.
// Mirrors packages/web/server/lib/quota/providers/openrouter.js (kept in sync
// per the quota DOCUMENTATION.md parity note).
const resolveOpenRouterConfigBase = (): string | null => {
  try {
    const config = readConfig();
    const readBaseURL = (sectionKey: 'providers' | 'provider'): string | null => {
      const section = config[sectionKey];
      return isRecord(section) ? asNonEmptyString(toProviderEntity(section.openrouter).settings?.baseURL) : null;
    };
    const base = (
      readBaseURL('providers') ?? readBaseURL('provider')
    )?.replace(/\/+$/, '');
    return base || null;
  } catch {
    // A config read failure must not take the default-endpoint lookup down.
    return null;
  }
};

type OpenRouterQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchOpenRouterQuota = async ({ readAuth = readOpenCodeCredentials }: OpenRouterQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openrouter'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(`${resolveOpenRouterConfigBase() ?? OPENROUTER_API_BASE}/key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with OpenRouter'
          : `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as unknown;
    const dataContainer = asObject(payload);
    const data = asObject(dataContainer?.data);
    if (data === null) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    if (data.is_management_key === true) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: 'Management key configured — quota needs an inference API key',
      });
    }

    const limit = toNumber(data.limit);
    const limitRemaining = toNumber(data.limit_remaining);
    if (limit !== null && limitRemaining === null) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const usageMonthly = toNumber(data.usage_monthly);
    if (limit === null && usageMonthly === null) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const nowMs = Date.now();
    let windowKey: string;
    let windowSeconds: number | null;
    let resetAt: number | null;
    let usedPercent: number | null;
    let valueLabel: string;

    if (limit === null) {
      windowKey = 'monthly';
      windowSeconds = PERIOD_SECONDS.monthly;
      resetAt = openRouterResetAt('monthly', nowMs);
      usedPercent = null;
      valueLabel = `$${formatMoney(usageMonthly)} spent`;
    } else {
      const used = Math.max(0, limit - (limitRemaining ?? 0));
      const percent = limit > 0 ? (used / limit) * 100 : null;
      usedPercent = percent === null ? null : Math.min(100, percent);
      valueLabel = `$${formatMoney(used)} / $${formatMoney(limit)}`;

      if (isOpenRouterPeriod(data.limit_reset)) {
        windowKey = data.limit_reset;
        windowSeconds = PERIOD_SECONDS[data.limit_reset];
        resetAt = openRouterResetAt(data.limit_reset, nowMs);
      } else {
        windowKey = 'key_limit';
        windowSeconds = null;
        resetAt = null;
      }
    }

    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: true,
      configured: true,
      usage: {
        windows: {
          [windowKey]: toUsageWindow({
            usedPercent,
            windowSeconds,
            resetAt,
            valueLabel,
          }),
        },
      },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted));
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : error instanceof Error ? error.message : 'Request failed',
    });
  }
};


export const normalizeTimestamp = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const resolveWindowSeconds = (limit: Record<string, unknown> | undefined) => {
  if (!limit || typeof limit.number !== 'number') return null;
  const unitSeconds = ZAI_TOKEN_WINDOW_SECONDS[Number(limit.unit)];
  if (!unitSeconds) return null;
  return unitSeconds * limit.number;
};

const resolveWindowLabel = (windowSeconds: number | null) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};

// Gift reset timestamps come as 'YYYY-MM-DD HH:mm:ss' in UTC+8.
const ZAI_RESET_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ZAI_ALIASES = ['zai-coding-plan', 'zai', 'z.ai'];

const parseZaiResetExpire = (value: string | undefined): number | null => {
  if (value === undefined || !ZAI_RESET_TIME_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(timestamp) ? null : timestamp;
};

// Keep only claimable resets: available, with a parseable, not-yet-expired time.
// The nearest expiry is the one worth activating first; expired records are
// pointless to show. z.ai flips `available` to false once a record expires.
const pickZaiGiftReset = (records: ZaiGiftResetRecord[] | undefined): UsageWindowGiftReset | null => {
  if (!Array.isArray(records)) return null;
  const now = Date.now();
  let best: UsageWindowGiftReset | null = null;
  for (const record of records) {
    if (!record || record.available !== true) continue;
    if (record.recordId === undefined) continue;
    const expireAt = parseZaiResetExpire(record.expireTime);
    if (expireAt === null || expireAt <= now) continue;
    if (best === null || expireAt < best.expireAt) {
      best = { recordId: record.recordId, expireAt };
    }
  }
  return best;
};

const ZAI_GIFT_RESET_URL = 'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL';
const ZAI_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const ZAI_WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// Supplementary call: gift reset info must never fail the quota result.
const attachZaiGiftResets = async (windows: Record<string, UsageWindow>, apiKey: string): Promise<void> => {
  try {
    const response = await fetch(ZAI_GIFT_RESET_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return;
    // SAFETY: readQuotaJson is untyped; only the two record arrays are consumed,
    // and every field they carry is re-checked by pickZaiGiftReset before use.
    const payload = await readQuotaJson(response) as ZaiGiftResetPayload;
    const data = payload?.data;
    if (!data) return;

    const fiveHour = pickZaiGiftReset(data.fiveHourResets);
    const weekly = pickZaiGiftReset(data.weekResets);

    for (const window of Object.values(windows)) {
      if (window.windowSeconds === ZAI_FIVE_HOUR_WINDOW_SECONDS && fiveHour) {
        window.giftReset = fiveHour;
      } else if (window.windowSeconds === ZAI_WEEK_WINDOW_SECONDS && weekly) {
        window.giftReset = weekly;
      }
    }
  } catch {
    // Gift resets are optional metadata; ignore failures.
  }
};

type ZaiQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchZaiQuota = async ({ readAuth = readOpenCodeCredentials }: ZaiQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ZAI_ALIASES)) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zai-coding-plan',
        providerName: 'z.ai',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as ZaiPayload;
    // Same monitor API family as bigmodel.cn: business failures arrive inside HTTP 200.
    const failure = zhipuaiEnvelopeError(payload);
    if (failure) {
      return buildResult({ providerId: 'zai-coding-plan', providerName: 'z.ai', ok: false, configured: true, error: failure });
    }
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
    const windows: Record<string, UsageWindow> = {};
    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the same,
    // so both limit types map to the same windows.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit as Record<string, unknown>);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;
      const usedPercent = typeof limit.percentage === 'number' ? clampPercent(limit.percentage) : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
        valueLabel: formatZaiCreditValueLabel(limit),
      });
    }

    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      windows['MCP Tools'] = toUsageWindow({
        usedPercent: typeof mcpToolsTimeLimit.percentage === 'number' ? clampPercent(mcpToolsTimeLimit.percentage) : null,
        windowSeconds: 30 * 24 * 60 * 60,
        resetAt: mcpToolsTimeLimit.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null,
      });
    }

    await attachZaiGiftResets(windows, apiKey);

    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: payload?.data?.level || null,
    });
  } catch (error) {
    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const ZAI_GIFT_RESET_USE_URL = 'https://api.z.ai/api/biz/customer-package-reset/use';
const ZAI_GIFT_RESET_TYPES = ['FIVE_HOUR', 'WEEK'] as const;

export type QuotaGiftResetType = (typeof ZAI_GIFT_RESET_TYPES)[number];

const activateZaiGiftReset = async (input: { recordId: number; resetType: QuotaGiftResetType }): Promise<void> => {
  const auth = await readOpenCodeCredentials();
  // SAFETY: auth.json is untyped storage; the cast only reads the optional
  // key/token fields and no other shape is consumed.
  const entry = normalizeAuthEntry(getAuthEntry(auth, ZAI_ALIASES)) as { key?: unknown; token?: unknown } | null;
  // SAFETY: a non-string key/token becomes an unusable bearer that the
  // !apiKey check rejects before any request leaves the host.
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    throw new Error('Not configured');
  }
  if (!Number.isFinite(input.recordId) || !ZAI_GIFT_RESET_TYPES.includes(input.resetType)) {
    throw new Error('Invalid gift reset request');
  }

  const response = await fetch(ZAI_GIFT_RESET_USE_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'PERSONAL',
      resetType: input.resetType,
      recordId: input.recordId,
      requestId: crypto.randomUUID(),
    }),
  });

  // SAFETY: readQuotaJson is untyped; only success/msg are consumed and both
  // are re-checked before use.
  const payload = await readQuotaJson(response).catch(() => null) as ZaiGiftResetUsePayload | null;
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.msg || `API error: ${response.status}`);
  }
};

export const activateQuotaGiftReset = async (
  providerId: string,
  input: { recordId: number; resetType: QuotaGiftResetType },
): Promise<void> => {
  if (!ZAI_ALIASES.includes(providerId)) {
    throw new Error('Unsupported provider');
  }
  await activateZaiGiftReset(input);
};

type ZhipuaiQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchZhipuaiCodingPlanQuota = async ({ readAuth = readOpenCodeCredentials }: ZhipuaiQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zhipuai-coding-plan',
        providerName: 'Zhipu AI Coding Plan',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as ZhipuaiPayload;

    const failure = zhipuaiEnvelopeError(payload);
    if (failure) {
      return buildResult({
        providerId: 'zhipuai-coding-plan',
        providerName: 'Zhipu AI Coding Plan',
        ok: false,
        configured: true,
        error: failure,
      });
    }

    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const windows: Record<string, UsageWindow> = {};

    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the
    // same, so both limit types map to the same windows. Unit 3 marks hourly
    // blocks (5h), unit 6 weekly.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit as Record<string, unknown>);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent: resolveZhipuaiUsedPercent(limit),
        windowSeconds,
        resetAt,
        valueLabel: formatZhipuaiCreditValueLabel(limit),
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? clampPercent(mcpToolsTimeLimit.percentage) : null;

      windows['MCP Tools'] = toUsageWindow({
        usedPercent,
        windowSeconds: monthSeconds,
        resetAt,
      });
    }

    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: payload?.data?.level || null,
    });
  } catch (error) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const nanoGptQuotaWindowSchema = z.object({
  percentUsed: z.number().nullish(),
  used: z.union([z.number(), z.string()]).nullish(),
  limit: z.union([z.number(), z.string()]).nullish(),
  limits: z.object({
    daily: z.union([z.number(), z.string()]).nullish(),
    monthly: z.union([z.number(), z.string()]).nullish(),
  }).nullish(),
  resetAt: z.union([z.number(), z.string()]).nullish(),
  degraded: z.boolean().optional(),
}).nullish();

const nanoGptUsageSchema = z.object({
  state: z.string().nullish(),
  period: z.object({ currentPeriodEnd: z.union([z.number(), z.string()]).nullish() }).nullish(),
  limits: z.object({
    dailyInputTokens: z.number().nullish(),
    weeklyInputTokens: z.number().nullish(),
  }).nullish(),
  dailyInputTokens: nanoGptQuotaWindowSchema,
  weeklyInputTokens: nanoGptQuotaWindowSchema,
  daily: nanoGptQuotaWindowSchema,
  monthly: nanoGptQuotaWindowSchema,
});

const NANO_GPT_DAILY_WINDOW_SECONDS = 86400;

type NanoGptQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchNanoGptQuota = async ({ readAuth = readOpenCodeCredentials }: NanoGptQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://nano-gpt.com/api/subscription/v1/usage', {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'nano-gpt',
        providerName: 'NanoGPT',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = nanoGptUsageSchema.parse(await readQuotaJson(response));
    const windows: ProviderUsage['windows'] = {};
    const state = payload.state ?? 'active';
    // A null current daily quota means no daily cap; only absent fields use legacy data.
    const daily = payload.dailyInputTokens !== undefined ? payload.dailyInputTokens : payload.daily;
    const quotas = [
      {
        name: 'daily',
        quota: daily,
        limit: payload.dailyInputTokens !== undefined
          ? payload.limits?.dailyInputTokens
          : daily?.limit ?? daily?.limits?.daily,
        windowSeconds: NANO_GPT_DAILY_WINDOW_SECONDS,
        resetAt: daily?.resetAt,
      },
      {
        name: 'weekly',
        quota: payload.weeklyInputTokens,
        limit: payload.limits?.weeklyInputTokens,
        windowSeconds: 7 * NANO_GPT_DAILY_WINDOW_SECONDS,
        resetAt: payload.weeklyInputTokens?.resetAt,
      },
      {
        name: 'monthly',
        quota: payload.monthly,
        limit: payload.monthly?.limit ?? payload.monthly?.limits?.monthly,
        windowSeconds: null,
        resetAt: payload.monthly?.resetAt ?? payload.period?.currentPeriodEnd,
      },
    ];

    for (const { name, quota, limit: rawLimit, windowSeconds, resetAt } of quotas) {
      if (!quota) continue;
      const percentUsed = toNumber(quota.percentUsed);
      const used = toNumber(quota.used);
      const limit = toNumber(rawLimit);
      let usedPercent: number | null = null;
      if (!quota.degraded) {
        if (percentUsed !== null) {
          usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
        } else if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      windows[name] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt: toTimestamp(resetAt),
        valueLabel: state !== 'active' ? `(${state})` : null,
      });
    }

    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const WAFER_QUOTA_URL = 'https://pass.wafer.ai/v1/inference/quota';
const WAFER_WINDOW_SECONDS = 5 * 3600;

const fetchWaferQuota = async (): Promise<ProviderResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'wafer',
      providerName: 'Wafer.ai',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(WAFER_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'wafer',
        providerName: 'Wafer.ai',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as WaferPayload;
    const remaining = toNumber(payload?.remaining_included_requests);
    const limit = toNumber(payload?.included_request_limit);
    const overage = toNumber(payload?.overage_request_count);
    const usedPercentRaw = toNumber(payload?.current_period_used_percent);
    const windowStart = toTimestamp(payload?.window_start);
    const windowEnd = toTimestamp(payload?.window_end);
    const planTier = asNonEmptyString(payload?.plan_tier);

    if (remaining === null && limit === null && overage === null && usedPercentRaw === null) {
      return buildResult({
        providerId: 'wafer',
        providerName: 'Wafer.ai',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const hasOverage = overage !== null && overage > 0;
    // A present percent keeps the deliberate overage behaviour (no 100 clamp
    // when overage is present). An absent percent must not be fabricated as
    // 0: derive it from the remaining/limit counts in the same payload when
    // both are present, and report null when there is nothing to derive from.
    let usedPercent: number | null = null;
    if (usedPercentRaw !== null) {
      usedPercent = hasOverage
        ? Math.max(0, usedPercentRaw)
        : Math.max(0, Math.min(100, usedPercentRaw));
    } else if (remaining !== null && limit !== null && limit > 0) {
      usedPercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    }

    const windowSeconds = windowStart !== null && windowEnd !== null
      ? Math.round((windowEnd - windowStart) / 1000)
      : WAFER_WINDOW_SECONDS;
    const windowLabel = resolveWindowLabel(windowSeconds);

    let valueLabel: string | null = null;
    if (remaining !== null && limit !== null) {
      const parts: string[] = [];
      if (planTier) parts.push(planTier);
      parts.push(`${remaining} / ${limit} left`);
      if (hasOverage) parts.push(`+${overage} overage`);
      valueLabel = parts.join(' · ');
    }

    const windows: Record<string, UsageWindow> = {};
    windows[windowLabel] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt: windowEnd,
      valueLabel,
    });

    return buildResult({
      providerId: 'wafer',
      providerName: 'Wafer.ai',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'wafer',
      providerName: 'Wafer.ai',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const NEURALWATT_QUOTA_URL = 'https://api.neuralwatt.com/v1/quota';

// 30d month / 365d year are fixed approximations; real calendars vary but the
// window is for the UI's progress bar label, not billing decisions.
// Accepts both subscription (month/year) and allowance (monthly/weekly/daily) shapes.
const neuralwattWindowSeconds = (period: string | null | undefined): number | null => {
  if (period === 'daily') return 86400;
  if (period === 'weekly') return 604800;
  if (period === 'monthly' || period === 'month') return 30 * 86400;
  if (period === 'yearly' || period === 'year') return 365 * 86400;
  return null;
};

type NeuralwattQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchNeuralwattQuota = async ({ readAuth = readOpenCodeCredentials }: NeuralwattQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['neuralwatt'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'neuralwatt',
      providerName: 'NeuralWatt',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(NEURALWATT_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'neuralwatt',
        providerName: 'NeuralWatt',
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with NeuralWatt'
          : `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as NeuralwattPayload;
    const subscription = payload?.subscription ?? null;
    const inOverage = Boolean(subscription?.in_overage);
    const allowance = payload?.key?.allowance ?? null;
    const creditsRemaining = toNumber(payload?.balance?.credits_remaining_usd);

    const windows: Record<string, UsageWindow> = {};

    if (subscription) {
      const kwhIncluded = toNumber(subscription.kwh_included);
      const kwhUsed = toNumber(subscription.kwh_used);
      const plan = typeof subscription.plan === 'string' && subscription.plan.trim()
        ? subscription.plan.trim()
        : null;
      // Subscription window title is the plan name; subscription limits reset
      // monthly even on annual billing plans, but the API exposes no kWh window
      // start to derive windowSeconds — pass null rather than fabricating a guess.
      const subKey = plan ?? 'plan_limit';
      const usedPercent = inOverage
        ? 100
        : (kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
            ? Math.max(0, Math.min(100, (kwhUsed / kwhIncluded) * 100))
            : null);
      const subResetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end);
      windows[subKey] = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt: subResetAt,
      });
    }

    if (allowance) {
      const spent = toNumber(allowance.spent_usd);
      const limit = toNumber(allowance.limit_usd);
      // Credits wallet is reduced by each period's spend before the allowance cap
      // bites, so the real ceiling is min(limit, creditsRemaining + spent).
      const effectiveSpent = spent ?? 0;
      const effectiveLimit = limit !== null && creditsRemaining !== null
        ? Math.min(limit, creditsRemaining + effectiveSpent)
        : (limit ?? creditsRemaining);
      const period = typeof allowance.period === 'string' && allowance.period.trim()
        ? allowance.period.trim()
        : null;
      const blocked = Boolean(allowance.blocked);
      const usedPercent = blocked
        ? 100
        : (spent !== null && effectiveLimit !== null && effectiveLimit > 0
            ? Math.max(0, Math.min(100, (spent / effectiveLimit) * 100))
            : null);
      // Window title is the localized period label (daily/weekly/monthly); the
      // usage value stays a percent so the UI's display-mode toggle applies.
      const periodKey = (period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'month')
        ? (period === 'month' ? 'monthly' : period)
        : 'billing_cycle';
      const resetAt = toTimestamp(allowance.reset_at);
      const windowSeconds = period ? neuralwattWindowSeconds(period) : null;
      windows[periodKey] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
      });
    } else if (creditsRemaining !== null) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(creditsRemaining)}`,
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId: 'neuralwatt',
        providerName: 'NeuralWatt',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    return buildResult({
      providerId: 'neuralwatt',
      providerName: 'NeuralWatt',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'neuralwatt',
      providerName: 'NeuralWatt',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const CLINE_PASS_USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits';

// Cline reports a rolling five-hour window, a rolling weekly window, and a
// calendar-month limit. Each window carries its duration so consumers can rank
// limits by how soon they run out; the calendar month has no fixed duration.
const CLINE_WINDOW_KINDS = new Map<string, ClineWindowKind>([
  ['five_hour', { key: '5h', windowSeconds: 5 * 60 * 60 }],
  ['weekly', { key: 'weekly', windowSeconds: 7 * 24 * 60 * 60 }],
  ['monthly', { key: 'monthly', windowSeconds: null }],
]);

type ClineQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchClinePassQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: ClineQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['cline-pass']));
  const apiKey = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

  if (!apiKey) {
    return buildResult({
      providerId: 'cline-pass',
      providerName: 'ClinePass',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetchImpl(CLINE_PASS_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'cline-pass',
        providerName: 'ClinePass',
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with ClinePass'
          : `API error: ${response.status}`,
      });
    }

    const payload = asObject(await readQuotaJson(response));
    const data = asObject(payload?.data);
    const limits = Array.isArray(data?.limits) ? data.limits : [];

    const windows: Record<string, UsageWindow> = {};
    for (const item of limits) {
      const limit = asObject(item);
      if (!limit) continue;
      const limitType = asNonEmptyString(limit.type);
      const kind = limitType === null ? undefined : CLINE_WINDOW_KINDS.get(limitType);
      if (!kind) continue;
      const rawUsedPercent = toNumber(asNonEmptyString(limit.percentUsed)
        ?? (Number.isFinite(limit.percentUsed) ? limit.percentUsed : null));
      const usedPercent = rawUsedPercent === null ? null : clampPercent(rawUsedPercent);
      if (usedPercent === null) continue;
      windows[kind.key] = toUsageWindow({
        usedPercent,
        windowSeconds: kind.windowSeconds,
        resetAt: toTimestamp(limit.resetsAt),
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId: 'cline-pass',
        providerName: 'ClinePass',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    return buildResult({
      providerId: 'cline-pass',
      providerName: 'ClinePass',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'cline-pass',
      providerName: 'ClinePass',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const DEEPINFRA_ME_URL = 'https://api.deepinfra.com/v1/me?checklist=true';

type DeepinfraQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchDeepinfraQuota = async ({ readAuth = readOpenCodeCredentials }: DeepinfraQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['deepinfra', 'deep-infra', 'deep_infra'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'deepinfra',
      providerName: 'DeepInfra',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(DEEPINFRA_ME_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'deepinfra',
        providerName: 'DeepInfra',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with DeepInfra'
          : `API error: ${response.status}`,
      });
    }

    // SAFETY: every DeepinfraPayload field is optional and the balance is parsed
    // below, so an unexpected body ends as "No quota data in response".
    const payload = await readQuotaJson(response) as DeepinfraPayload;
    // Documented at https://docs.deepinfra.com/api-reference/account/me:
    // checklist.stripe_balance is negative when funds are ready to spend and
    // positive when money is owed, so the spendable credit is its negation.
    const rawBalance = payload?.checklist?.stripe_balance;
    // A blank or absent balance is missing data, not a $0.00 balance.
    const stripeBalance = String(rawBalance ?? '').trim() === '' ? null : toNumber(rawBalance);

    if (stripeBalance === null) {
      return buildResult({
        providerId: 'deepinfra',
        providerName: 'DeepInfra',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const availableCredits = -stripeBalance;
    const symbol = availableCredits < 0 ? '-$' : '$';
    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `${symbol}${formatMoney(Math.abs(availableCredits))}`,
      }),
    };

    return buildResult({
      providerId: 'deepinfra',
      providerName: 'DeepInfra',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'deepinfra',
      providerName: 'DeepInfra',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const DEEPSEEK_QUOTA_URL = 'https://api.deepseek.com/user/balance';

type DeepseekQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
};

export const fetchDeepseekQuota = async ({ readAuth = readOpenCodeCredentials }: DeepseekQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['deepseek'])) as Record<string, unknown> | null;
  const apiKey = keyOrTokenFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(DEEPSEEK_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with DeepSeek'
          : `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response) as DeepseekPayload;
    const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const positiveBalances = balanceInfos.filter((info) => {
      const num = toNumber(info?.total_balance);
      return typeof num === 'number' && num > 0;
    });
    const balanceInfo = positiveBalances.find((info) => info?.currency === 'USD')
      ?? positiveBalances.find((info) => info?.currency === 'CNY')
      ?? balanceInfos.find((info) => info?.currency === 'USD')
      ?? balanceInfos.find((info) => info?.currency === 'CNY')
      ?? null;
    const rawBalance = balanceInfo?.total_balance;
    const totalBalance = (typeof rawBalance === 'number' || (typeof rawBalance === 'string' && rawBalance.trim() !== ''))
      ? toNumber(rawBalance)
      : null;

    if (totalBalance === null) {
      return buildResult({
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const symbol = balanceInfo?.currency === 'CNY' ? '¥' : '$';
    const windows: Record<string, UsageWindow> = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `${symbol}${formatMoney(totalBalance)}`,
      }),
    };

    return buildResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

// Meta Model API (Muse Code High Usage plan) quota. Mirrors
// `packages/web/server/lib/quota/providers/meta.js` — the VS Code extension
// duplicates this logic rather than importing the web provider. The VS Code
// ProviderResult has no accountLabel field, so unlike the web provider this
// port does not carry body.user_email — a deliberate surface difference.
//
// Data source: `POST https://api.meta.ai/muse-code/key` (`x-api-version: 1.0.0`,
// body `{ "onboard": false }`), the endpoint Meta's Muse Code CLI reads for
// `/usage`. `subs_usage.window` is the rolling window (labelled by
// `window_duration_mins`) and `subs_usage.weekly` the weekly one.
//
// The read authenticates with the Meta account OAuth token, not the minted
// inference key: the endpoint refuses a minted key with 401. The OpenCode `meta`
// credential is tried first; when it is the minted key, the account token comes
// from the Muse CLI's own login store (`~/.config/muse/auth.json`). A 402-class
// wall is `ok: false, quotaExhausted: true`, distinct from a read failure.
const META_KEY_URL = 'https://api.meta.ai/muse-code/key';

/** Epoch ms of the last successful (ok: true) Meta usage read in this process, or null. */
let metaLastSuccessAt: number | null = null;

/** Test seam: clears the in-process Meta last-success state between cases. */
export const resetMetaQuotaCache = (): void => {
  metaLastSuccessAt = null;
};
const META_WEEKLY_SECONDS = 7 * 24 * 60 * 60;
const MUSE_AUTH_PATH = path.join(os.homedir(), '.config', 'muse', 'auth.json');

const readMuseAccountToken = (): string | null => {
  const parsed = readJsonFile(MUSE_AUTH_PATH);
  const meta = asObject(asObject(parsed?.providers)?.meta);
  return asNonEmptyString(meta?.access_token);
};

// The Meta key endpoint's response shape. Every field is read defensively and
// a missing one falls through to null, so this describes what the parser
// accepts rather than a guarantee about the payload.
type MetaWindowPayload = {
  used_percent?: unknown;
  window_duration_mins?: unknown;
  resets_at?: unknown;
};
type MetaSubscriptionUsage = {
  window?: MetaWindowPayload;
  weekly?: MetaWindowPayload;
};
type MetaQuotaDetail = {
  limitKind?: string;
  limit_kind?: string;
  resetsAtMs?: number;
  resets_at?: number;
  resetsAt?: number;
  tier?: string;
};
type MetaKeyResponse = {
  is_subs_active?: boolean;
  require_payment?: boolean;
  subs_tier_name?: string;
  subs_usage?: MetaSubscriptionUsage;
  quota?: MetaQuotaDetail;
  message?: string;
  detail?: string;
  error?: { message?: string };
  resetsAtMs?: number;
  resets_at?: number;
  limitKind?: string;
  tier?: string;
};

const metaAccountTokenFromEntry = (entry: AuthEntry | null): string | null => {
  const fields = asObject(entry);
  return asNonEmptyString(fields?.access) ?? asNonEmptyString(fields?.accessToken) ?? asNonEmptyString(fields?.oauthAccessToken);
};

const metaKeyFromEntry = (entry: AuthEntry | null): string | null => {
  const fields = asObject(entry);
  return asNonEmptyString(fields?.key) ?? asNonEmptyString(fields?.token);
};

type MetaPlanOutcome =
  | { kind: 'usage'; body: MetaKeyResponse }
  | { kind: 'exhausted'; resetAt: number | null; limitKind: string | null; tier: string | null; message: string | null }
  | { kind: 'unauthorized' }
  | { kind: 'inactive' }
  | { kind: 'error'; message: string; failureClass: 'transport' | 'malformed' | 'http-error' };

const metaQuotaErrorDetail = (body: MetaKeyResponse | null) => {
  const quota = body?.quota;
  const resetRaw = quota?.resetsAtMs ?? quota?.resets_at ?? quota?.resetsAt ?? body?.resetsAtMs ?? body?.resets_at;
  return {
    resetAt: toTimestamp(resetRaw),
    limitKind: asNonEmptyString(quota?.limitKind) ?? asNonEmptyString(quota?.limit_kind) ?? asNonEmptyString(body?.limitKind),
    tier: asNonEmptyString(quota?.tier) ?? asNonEmptyString(body?.tier),
  };
};

const metaErrorMessage = (body: MetaKeyResponse | null): string | null =>
  asNonEmptyString(asObject(body?.error)?.message) ?? asNonEmptyString(body?.message) ?? asNonEmptyString(body?.detail) ?? null;

const requestMetaPlanUsage = async (
  bearer: string,
  fetchImpl: (url: string, options: RequestInit) => Promise<Response>,
): Promise<MetaPlanOutcome> => {
  const timeoutSignal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetchImpl(META_KEY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-version': '1.0.0',
      },
      body: JSON.stringify({ onboard: false }),
      signal: timeoutSignal,
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    return {
      kind: 'error',
      failureClass: error instanceof SyntaxError ? 'malformed' : 'transport',
      message: isTimeout
        ? 'Request timed out'
        : error instanceof SyntaxError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    };
  }

  // The body read can fail two ways: invalid JSON (a SyntaxError — the
  // response really is malformed) or a transport failure (the connection
  // dropped, or the deadline above fired mid-body). Keep the error from
  // readBody so the caller classifies the two differently instead of
  // reporting both as malformed.
  const readBody = async (): Promise<{ body: MetaKeyResponse | null; error: unknown }> => {
    try {
      // SAFETY: this is the Meta key endpoint's own response body; `MetaKeyResponse`
      // describes the fields the parser reads, each of which is checked before use.
      return { body: (await readQuotaJson(response)) as MetaKeyResponse, error: null };
    } catch (error) {
      return { body: null, error };
    }
  };

  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };

  if (response.status === 402 || response.status === 429) {
    const { body } = await readBody();
    return {
      kind: 'exhausted',
      ...metaQuotaErrorDetail(body),
      message: metaErrorMessage(body),
    };
  }

  if (!response.ok) return { kind: 'error', failureClass: 'http-error', message: `API error: ${response.status}` };

  const { body, error: bodyError } = await readBody();
  if (!body) {
    if (!bodyError) return { kind: 'error', failureClass: 'malformed', message: 'Invalid response from provider' };
    const isTimeout = bodyError instanceof DOMException && (
      bodyError.name === 'TimeoutError' || (bodyError.name === 'AbortError' && timeoutSignal.aborted)
    );
    return {
      kind: 'error',
      failureClass: bodyError instanceof SyntaxError ? 'malformed' : 'transport',
      message: isTimeout
        ? 'Request timed out'
        : bodyError instanceof SyntaxError
          ? 'Invalid response from provider'
          : (bodyError instanceof Error ? bodyError.message : 'Request failed'),
    };
  }
  if (body.is_subs_active === false) return { kind: 'inactive' };
  if (body.require_payment === true) {
    return { kind: 'exhausted', ...metaQuotaErrorDetail(body), message: metaErrorMessage(body) };
  }
  return { kind: 'usage', body };
};

const toMetaUsedPercent = (value: MetaWindowPayload['used_percent']): number | null => {
  const percent = toNumber(value);
  return percent === null ? null : clampPercent(percent);
};

const metaWindowsFrom = (subsUsage: MetaSubscriptionUsage | undefined) => {
  const windows = new Map<string, UsageWindow>();

  const rolling = subsUsage?.window;
  if (rolling) {
    const durationMinutes = toNumber(rolling.window_duration_mins);
    const windowSeconds = durationMinutes !== null && durationMinutes > 0 ? durationMinutes * 60 : null;
    windows.set(windowSeconds ? resolveWindowLabel(windowSeconds) : 'rolling', toUsageWindow({
      usedPercent: toMetaUsedPercent(rolling.used_percent),
      windowSeconds,
      resetAt: toTimestamp(rolling.resets_at),
    }));
  }

  const weekly = subsUsage?.weekly;
  if (weekly) {
    windows.set('weekly', toUsageWindow({
      usedPercent: toMetaUsedPercent(weekly.used_percent),
      windowSeconds: META_WEEKLY_SECONDS,
      resetAt: toTimestamp(weekly.resets_at),
    }));
  }

  return Object.fromEntries(windows);
};

const metaOutcomeToResult = (outcome: MetaPlanOutcome): ProviderResult => {
  if (outcome.kind === 'exhausted') {
    const detail = outcome.message && outcome.message !== 'Subscription quota exhausted' ? `: ${outcome.message}` : '';
    return {
      ...buildResult({
        providerId: 'meta',
        providerName: 'Meta Model API',
        ok: false,
        configured: true,
        error: `Subscription quota exhausted${detail}`,
        planLabel: outcome.tier,
      }),
      quotaExhausted: true,
      quotaResetAt: outcome.resetAt,
      failureClass: 'exhausted',
    };
  }
  if (outcome.kind === 'inactive') {
    return { ...buildResult({ providerId: 'meta', providerName: 'Meta Model API', ok: false, configured: true, error: 'Meta subscription is inactive' }), failureClass: 'inactive' };
  }
  if (outcome.kind === 'error') {
    return { ...buildResult({ providerId: 'meta', providerName: 'Meta Model API', ok: false, configured: true, error: outcome.message }), failureClass: outcome.failureClass };
  }
  if (outcome.kind === 'unauthorized') {
    return {
      ...buildResult({
        providerId: 'meta',
        providerName: 'Meta Model API',
        ok: false,
        configured: true,
        error: 'Meta plan usage needs the account login — sign in with the Muse Code CLI or store its account token',
      }),
      failureClass: 'unauthorized',
    };
  }

  const body = outcome.body;
  let windows = metaWindowsFrom(body.subs_usage);
  if (Object.keys(windows).length === 0) {
    // Post-roll state, captured live on 2026-10-28: after a window rolls
    // unspent, the endpoint answers 200 with an active subscription and no
    // subs_usage at all. That is a window open with no usage yet, so report
    // the plan's two windows with unknown percentages, the same shape an
    // empty window object already maps to, instead of a read failure. A
    // body that does not say the subscription is active carries no such
    // signal and stays a failure.
    if (body.is_subs_active !== true) {
      return { ...buildResult({ providerId: 'meta', providerName: 'Meta Model API', ok: false, configured: true, error: 'Usage unknown — Meta plan-usage read returned no quota data' }), failureClass: 'no-data' };
    }
    windows = metaWindowsFrom({ window: {}, weekly: {} });
  }
  return buildResult({
    providerId: 'meta',
    providerName: 'Meta Model API',
    ok: true,
    configured: true,
    planLabel: asNonEmptyString(body.subs_tier_name),
    usage: { windows },
  });
};

type MetaQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  readAccountToken?: () => string | null;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchMetaQuota = async ({
  readAuth = readOpenCodeCredentials,
  readAccountToken = readMuseAccountToken,
  fetchImpl = fetch,
}: MetaQuotaDependencies = {}): Promise<ProviderResult> => {
  const entry = normalizeAuthEntry(getAuthEntry(await readAuth(), ['meta']));
  const primary = metaAccountTokenFromEntry(entry) ?? metaKeyFromEntry(entry);

  if (!primary) {
    return buildResult({ providerId: 'meta', providerName: 'Meta Model API', ok: false, configured: false, error: 'Not configured' });
  }

  // Every configured result carries the last-success timestamp, mirroring
  // the web provider: a success moves it to this read's time, a failure
  // leaves it where the last success put it (null when none has succeeded).
  const finishRead = (result: ProviderResult): ProviderResult => {
    if (result.ok) {
      metaLastSuccessAt = result.fetchedAt;
    }
    return { ...result, lastSuccessAt: metaLastSuccessAt };
  };

  const first = await requestMetaPlanUsage(primary, fetchImpl);
  if (first.kind !== 'unauthorized') return finishRead(metaOutcomeToResult(first));

  const fallback = readAccountToken();
  if (!fallback || fallback === primary) return finishRead(metaOutcomeToResult(first));

  return finishRead(metaOutcomeToResult(await requestMetaPlanUsage(fallback, fetchImpl)));
};

const HYPER_QUOTA_URL = 'https://hyper.charm.land/v1/credits';
const HYPER_CREDIT_TO_USD = 0.05;

const getHyperApiKey = (auth: AuthFile) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['hyper']));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

type HyperQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchHyperQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: HyperQuotaDependencies = {}): Promise<ProviderResult> => {
  const apiKey = getHyperApiKey(await readAuth());

  if (!apiKey) {
    return buildResult({
      providerId: 'hyper',
      providerName: 'Charm Hyper',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetchImpl(HYPER_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'hyper',
        providerName: 'Charm Hyper',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with Charm Hyper'
          : `API error: ${response.status}`,
      });
    }

    const payload = asObject(await readQuotaJson(response));
    const rawBalance = payload?.balance;
    const balance = toNumber(asNonEmptyString(rawBalance)
      ?? (Number.isFinite(rawBalance) ? rawBalance : null));

    if (balance === null) {
      return buildResult({
        providerId: 'hyper',
        providerName: 'Charm Hyper',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const creditsLabel = Number.isInteger(balance) ? String(balance) : formatMoney(balance);
    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance * HYPER_CREDIT_TO_USD)}`,
      }),
      credits: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: creditsLabel,
      }),
    };

    return buildResult({
      providerId: 'hyper',
      providerName: 'Charm Hyper',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'hyper',
      providerName: 'Charm Hyper',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const ZENMUX_BALANCE_URL = 'https://zenmux.ai/api/v1/management/payg/balance';

type ZenmuxManagedCredential = {
  platformApiKey: string;
};

type ZenmuxQuotaDependencies = {
  readCredential?: () => ZenmuxManagedCredential | null;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

const readZenmuxManagedCredential = (): ZenmuxManagedCredential | null => {
  const platformApiKey = asNonEmptyString(readCredential('zenmux')?.platformApiKey);
  return platformApiKey ? { platformApiKey } : null;
};

export const fetchZenmuxQuota = async ({
  readCredential: readManaged = readZenmuxManagedCredential,
  fetchImpl = fetch,
}: ZenmuxQuotaDependencies = {}): Promise<ProviderResult> => {
  const apiKey = asNonEmptyString(readManaged()?.platformApiKey);

  if (!apiKey) {
    return buildResult({
      providerId: 'zenmux',
      providerName: 'ZenMux',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetchImpl(ZENMUX_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zenmux',
        providerName: 'ZenMux',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Invalid ZenMux Platform API key'
          : `API error: ${response.status}`,
      });
    }

    const payload = asObject(await readQuotaJson(response));
    const data = asObject(payload?.data);
    const rawCredits = data?.total_credits;
    const totalCredits = toNumber(asNonEmptyString(rawCredits)
      ?? (Number.isFinite(rawCredits) ? rawCredits : null));

    if (totalCredits === null) {
      return buildResult({
        providerId: 'zenmux',
        providerName: 'ZenMux',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(totalCredits)}`,
      }),
    };

    return buildResult({
      providerId: 'zenmux',
      providerName: 'ZenMux',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'zenmux',
      providerName: 'ZenMux',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

const KILO_BALANCE_URL = 'https://api.kilo.ai/api/profile/balance';
const KILO_AUTH_ALIASES = ['kilo', 'kilocode', 'kilo-code'];

const getKiloAuthEntry = (auth: AuthFile) => normalizeAuthEntry(getAuthEntry(auth, KILO_AUTH_ALIASES));

const getKiloApiKey = (auth: AuthFile) => {
  const entry = getKiloAuthEntry(auth);
  return asNonEmptyString(entry?.key)
    ?? asNonEmptyString(entry?.token)
    ?? asNonEmptyString(entry?.access);
};

const readKiloOrganizationIdFromUserConfig = (): string | null => {
  try {
    const configPath = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
    if (!fs.existsSync(configPath)) return null;
    const parsed = asObject(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    const provider = asObject(parsed?.provider);
    const kilo = asObject(provider?.kilo) ?? asObject(provider?.kilocode);
    const options = asObject(kilo?.options);
    return asNonEmptyString(options?.kilocodeOrganizationId)
      ?? asNonEmptyString(options?.organizationId);
  } catch {
    return null;
  }
};

type KiloQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  readOrganizationId?: () => string | null;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchKiloQuota = async ({
  readAuth = readOpenCodeCredentials,
  readOrganizationId = readKiloOrganizationIdFromUserConfig,
  fetchImpl = fetch,
}: KiloQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = getKiloAuthEntry(auth);
  const apiKey = getKiloApiKey(auth);

  if (!apiKey) {
    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const organizationId = asNonEmptyString(entry?.kilocodeOrganizationId)
    ?? asNonEmptyString(entry?.organizationId)
    ?? asNonEmptyString(entry?.accountId)
    ?? readOrganizationId();

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const headers = organizationId
      ? {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
          'x-kilocode-organizationid': organizationId,
        }
      : {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
        };

    const response = await fetchImpl(KILO_BALANCE_URL, {
      method: 'GET',
      headers,
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'kilo',
        providerName: 'Kilo Code',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with Kilo Code'
          : `API error: ${response.status}`,
      });
    }

    const payload = asObject(await readQuotaJson(response));
    const rawBalance = payload?.balance;
    const balance = toNumber(asNonEmptyString(rawBalance)
      ?? (Number.isFinite(rawBalance) ? rawBalance : null));

    if (balance === null) {
      return buildResult({
        providerId: 'kilo',
        providerName: 'Kilo Code',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance)}`,
      }),
    };

    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

type XaiQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchXaiQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: XaiQuotaDependencies = {}): Promise<ProviderResult> => {
  try {
    const entry = resolveXaiAuth(await readAuth());
    if (!entry) {
      return buildResult({
        providerId: 'xai',
        providerName: 'xAI',
        ok: false,
        configured: false,
        error: 'Not configured',
      });
    }

    const accessToken = requireXaiAccessToken(entry);
    const response = await fetchImpl(XAI_USAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/?_s=usage',
        Accept: '*/*',
        'Content-Type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        'x-user-agent': 'connect-es/2.1.1',
        'User-Agent': 'OpenChamber',
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(15_000),
    });

    const grpcStatus = response.headers.get('grpc-status');
    if (grpcStatus !== null) {
      const rawStatus = grpcStatus.trim();
      if (!/^\d+$/.test(rawStatus)) throw new Error('xAI billing returned malformed gRPC status');
      const status = Number(rawStatus);
      if (!Number.isSafeInteger(status)) throw new Error('xAI billing returned malformed gRPC status');
      if (status !== 0) {
        throw new Error(`xAI billing RPC failed with status ${status}`);
      }
    }

    if (!response.ok) {
      throw new Error(`xAI billing API error: ${response.status}`);
    }

    const parsed = parseXaiUsage(await readQuotaBytes(response));
    return buildResult({
      providerId: 'xai',
      providerName: 'xAI',
      ok: true,
      configured: true,
      usage: {
        windows: {
          billing_cycle: toUsageWindow({
            usedPercent: parsed.usedPercent,
            windowSeconds: null,
            resetAt: parsed.resetAt,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: 'xai',
      providerName: 'xAI',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';

const mistralApiKeyFrom = (entry: ReturnType<typeof normalizeAuthEntry>): string | null =>
  asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token) ?? asNonEmptyString(entry?.access);

type MistralQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

/**
 * Mistral AI quota — key-validity class, ported from the web provider
 * (packages/web/server/lib/quota/providers/mistral.js). Mistral exposes no
 * usage or balance read to a standard API key (#1619), so this tracks the
 * one thing the credential can prove: `GET /v1/models` with the enrolled
 * `mistral` credential — 200 with the documented `data` array -> ok with
 * empty windows and the `usageAvailability: 'console-only'` marker;
 * 401/403 -> the unauthorized class; a 200 without `data` -> the malformed
 * class. No usage or balance figures are ever emitted.
 */
export const fetchMistralQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: MistralQuotaDependencies = {}): Promise<ProviderResult> => {
  const entry = normalizeAuthEntry(getAuthEntry(await readAuth(), ['mistral']));
  const apiKey = mistralApiKeyFrom(entry);

  if (!apiKey) {
    return buildResult({
      providerId: 'mistral',
      providerName: 'Mistral AI',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetchImpl(MISTRAL_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'mistral',
        providerName: 'Mistral AI',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Invalid or revoked API key \u2014 Mistral rejected the enrolled credential'
          : `API error: ${response.status}`,
      });
    }

    const payload = await readQuotaJson(response);

    if (!Array.isArray(asObject(payload)?.data)) {
      return buildResult({
        providerId: 'mistral',
        providerName: 'Mistral AI',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    return buildResult({
      providerId: 'mistral',
      providerName: 'Mistral AI',
      ok: true,
      configured: true,
      usage: {
        windows: {},
        usageAvailability: 'console-only',
      },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'mistral',
      providerName: 'Mistral AI',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

type CommandCodeQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

const COMMAND_CODE_API_BASE_URL = 'https://api.commandcode.ai';
const COMMAND_CODE_ALIASES = ['command-code', 'commandcode', 'command_code', 'command code'];

/** The Go plan's included monthly credits (Drew's quota READ RULE, 2026-11-01). */
const COMMAND_CODE_MONTHLY_INCLUDED_CREDITS = 10;

const commandCodeApiKey = (auth: AuthFile): string | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, COMMAND_CODE_ALIASES));
  const stored = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  return stored ?? asNonEmptyString(process.env.COMMAND_CODE_API_KEY) ?? null;
};

const commandCodeFormatCredits = (value: number): string => String(Math.round((value + Number.EPSILON) * 100) / 100);

const parseCommandCodeCredits = (payload: QuotaJsonValue): Record<string, UsageWindow> => {
  const root = asObject(payload);
  const credits = asObject(root?.credits);
  const limits = asObject(root?.windowLimits);
  const windows: Record<string, UsageWindow> = {};

  const monthlyRemaining = toNumber(credits?.monthlyCredits);
  if (monthlyRemaining !== null && monthlyRemaining >= 0 && monthlyRemaining <= COMMAND_CODE_MONTHLY_INCLUDED_CREDITS) {
    const monthlyUsed = COMMAND_CODE_MONTHLY_INCLUDED_CREDITS - monthlyRemaining;
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (monthlyUsed / COMMAND_CODE_MONTHLY_INCLUDED_CREDITS) * 100)),
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${commandCodeFormatCredits(monthlyUsed)} / ${commandCodeFormatCredits(COMMAND_CODE_MONTHLY_INCLUDED_CREDITS)}`,
    });
  }

  // Balance windows carry no percent: purchased/free credits are balances,
  // not plan usage (the monthly plan window above is the quota figure).
  for (const [label, field] of [['purchased_credits', 'purchasedCredits'], ['free_credits', 'freeCredits']] as const) {
    const value = toNumber(credits?.[field]);
    if (value !== null) {
      windows[label] = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: commandCodeFormatCredits(value) });
    }
  }

  for (const [label, field, windowSeconds] of [['5h', 'fiveHour', 5 * 60 * 60], ['weekly', 'weekly', 7 * 24 * 60 * 60]] as const) {
    const limit = asObject(limits?.[field]);
    const used = toNumber(limit?.used);
    const cap = toNumber(limit?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    const resetAt = toNumber(limit?.resetAt);
    windows[label] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
      windowSeconds,
      resetAt: resetAt === null ? null : resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt,
      valueLabel: `${commandCodeFormatCredits(used)} / ${commandCodeFormatCredits(cap)}`,
    });
  }

  return windows;
};

/**
 * Command Code quota — ported from the web provider
 * (packages/web/server/lib/quota/providers/command-code.js), closing the
 * VS Code surface gap in #1744. Per Drew's quota READ RULE (2026-11-01)
 * Command Code reads report the PLAN windows; the top-up balance
 * (purchasedCredits) is never a quota figure — it rides along as a
 * percent-less balance window, exactly as the web provider publishes it.
 */
export const fetchCommandCodeQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: CommandCodeQuotaDependencies = {}): Promise<ProviderResult> => {
  const providerId = 'command-code';
  const providerName = 'Command Code';
  const apiKey = commandCodeApiKey(await readAuth());
  if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });

  const requestJson = async (requestPath: string): Promise<QuotaJsonValue> => {
    const response = await fetchImpl(`${COMMAND_CODE_API_BASE_URL}${requestPath}`, {
      headers: {
        Accept: 'application/json',
Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'OpenChamber quota provider',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) throw new Error('Command Code authentication failed');
    if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`);
    return readQuotaJson(response).catch(() => null);
  };

  try {
    const identity = asObject(await requestJson('/alpha/whoami'));
    const orgId = asNonEmptyString(asObject(identity?.org)?.id) ?? '';
    const creditsPath = orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : '/alpha/billing/credits';
    const windows = parseCommandCodeCredits(await requestJson(creditsPath));
    if (Object.keys(windows).length === 0) throw new Error('Command Code usage data could not be parsed');
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};

type OpenDesignQuotaDependencies = {
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

const OPEN_DESIGN_API_BASE_URL = 'https://amr-api.open-design.ai/api';

const OPEN_DESIGN_IMPORT_REQUIRED_ERROR = 'Import the Open Design session cookie in Settings to read Open Design quota';
const OPEN_DESIGN_SESSION_EXPIRED_ERROR = 'Open Design session expired; import a fresh session cookie in Settings';

// The console reports plan windows by duration: 18000 seconds is the 5-hour
// window and 604800 is the 7-day window. Windows of any other duration are
// not part of the published plan shape and are left out.
const OPEN_DESIGN_WINDOW_LABELS = new Map<number, string>([
  [18000, '5h'],
  [604800, '7d'],
]);

const parseOpenDesignCodingPlanWindows = (payload: QuotaJsonValue): Record<string, UsageWindow> | null => {
  const data = asObject(payload);
  if (!data || !Array.isArray(data.windows)) return null;

  const windows: Record<string, UsageWindow> = {};
  for (const entry of data.windows) {
    const record = asObject(entry);
    if (!record) continue;
    const label = OPEN_DESIGN_WINDOW_LABELS.get(toNumber(record.durationSeconds) ?? Number.NaN);
    if (!label) continue;
    const limit = toNumber(record.limitCredits);
    const remaining = toNumber(record.remainingCredits);
    if (limit === null || remaining === null) continue;
    const usedPercent = limit > 0 ? Math.min(100, Math.max(0, (1 - remaining / limit) * 100)) : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: toNumber(record.durationSeconds),
      resetAt: toTimestamp(record.resetsAt),
      valueLabel: `${remaining} / ${limit} credits`,
    });
  }
  return Object.keys(windows).length > 0 ? windows : null;
};

/**
 * Open Design quota — ported from the web provider
 * (packages/web/server/lib/quota/providers/opendesign.js), closing the
 * VS Code surface gap in #1744. The billing usage API refuses the
 * OpenCode-held AMR inference key (verified 403): the read rides the
 * managed Better Auth session credential in the shared managed store
 * (quota/opendesign.json under the OpenChamber data dir — the same file
 * the web surface and the renewal keeper use). The web provider's
 * per-model breakdown is not ported: the VS Code ProviderUsage contract
 * has no slot for that array shape, so this surface publishes the plan
 * windows only.
 */
export const fetchOpenDesignQuota = async ({ fetchImpl = fetch }: OpenDesignQuotaDependencies = {}): Promise<ProviderResult> => {
  const providerId = 'opendesign';
  const providerName = 'Open Design';
  const credential = readCredential('opendesign');
  if (!credential) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: OPEN_DESIGN_IMPORT_REQUIRED_ERROR });
  }

  const headers = {
    Accept: 'application/json',
Cookie: credential.cookie,
    'x-vela-workspace-id': credential.workspaceId,
    'User-Agent': 'OpenChamber quota provider',
  };
  const workspaceUrl = (suffix: string): string =>
    `${OPEN_DESIGN_API_BASE_URL}/v1/workspaces/${encodeURIComponent(credential.workspaceId)}/billing/${suffix}`;

  try {
    const sessionResponse = await fetchImpl(`${OPEN_DESIGN_API_BASE_URL}/auth/get-session`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const session = sessionResponse.ok ? await readQuotaJson(sessionResponse).catch(() => null) : null;
    if (!asObject(session)) throw new Error(OPEN_DESIGN_SESSION_EXPIRED_ERROR);

    const usageResponse = await fetchImpl(workspaceUrl('coding-plan-usage'), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      throw new Error(OPEN_DESIGN_SESSION_EXPIRED_ERROR);
    }
    if (!usageResponse.ok) {
      throw new Error(`Open Design usage API returned HTTP ${usageResponse.status}`);
    }
    const windows = parseOpenDesignCodingPlanWindows(await readQuotaJson(usageResponse).catch(() => null));
    if (!windows) throw new Error('Open Design usage data could not be parsed');
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};

const fetchQuotaForProviderUncoalesced = async (providerId: string): Promise<ProviderResult> => {
  switch (providerId) {
    case 'claude':
      return fetchClaudeQuota();
    case 'codex':
      return fetchCodexQuota();
    case 'github-copilot':
      return fetchCopilotQuota();
    case 'google':
      return fetchGoogleQuota();
    case 'antigravity':
      return fetchAntigravityQuota();
    case 'kimi-for-coding':
      return fetchKimiQuota();
    case 'meta':
      return fetchMetaQuota();
    case 'nano-gpt':
      return fetchNanoGptQuota();
    case 'minimax-coding-plan':
      return fetchMiniMaxCodingPlanQuota();
    case 'minimax-cn-coding-plan':
      return fetchMiniMaxCnCodingPlanQuota();
    case 'ollama-cloud':
      return fetchOllamaCloudQuota();
    case 'exe-dev':
      return fetchExeDevQuota();
    case 'openrouter':
      return fetchOpenRouterQuota();
    case 'zai-coding-plan':
      return fetchZaiQuota();
    case 'zhipuai-coding-plan':
      return fetchZhipuaiCodingPlanQuota();
    case 'wafer':
      return fetchWaferQuota();
    case 'opencode-go': {
      try {
        deleteLegacyOpenCodeGoCredential();
        const auth = await readOpenCodeCredentials();
        // A Console sign-in serves OpenCode Go once it exists; the
        // API key is the fallback for accounts without one, and for a Console
        // read that fails (no Go in that org, an endpoint change, a hiccup).
        const consoleCredential = openCodeGoConsoleCredential(auth);
        const apiKey = openCodeGoApiKey(auth);
        if (consoleCredential) {
          try {
            const consoleUsage = await fetchOpenCodeGoUsage(consoleCredential);
            return buildResult({ providerId, providerName: 'OpenCode Go', ok: true, configured: true, usage: { windows: consoleUsage.windows }, planLabel: consoleUsage.planLabel });
          } catch (consoleError) {
            if (!apiKey) throw consoleError;
          }
        }
        if (!apiKey) return buildResult({ providerId, providerName: 'OpenCode Go', ok: false, configured: false, error: 'Not configured' });
        const apiKeyUsage = await fetchOpenCodeGoUsage(apiKey);
        return buildResult({ providerId, providerName: 'OpenCode Go', ok: true, configured: true, usage: { windows: apiKeyUsage.windows }, planLabel: apiKeyUsage.planLabel });
      } catch (error) {
        return buildResult({ providerId, providerName: 'OpenCode Go', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
      }
    }
    case 'cursor':
      return fetchCursorQuota();
    case 'cline-pass':
      return fetchClinePassQuota();
    case 'deepinfra':
      return fetchDeepinfraQuota();
    case 'deepseek':
      return fetchDeepseekQuota();
    case 'hyper':
      return fetchHyperQuota();
    case 'neuralwatt':
      return fetchNeuralwattQuota();
    case 'kilo':
      return fetchKiloQuota();
    case 'zenmux':
      return fetchZenmuxQuota();
    case 'xai':
      return fetchXaiQuota();
    case 'mistral':
      return fetchMistralQuota();
    case 'command-code':
      return fetchCommandCodeQuota();
    case 'opendesign':
      return fetchOpenDesignQuota();
    default:
      return buildResult({
        providerId,
        providerName: providerId,
        ok: false,
        configured: false,
        error: 'Unsupported provider',
      });
  }
};

const pendingQuotaFetches = new Map<string, Promise<ProviderResult>>();

export const fetchQuotaForProvider = (providerId: string): Promise<ProviderResult> => {
  const existing = pendingQuotaFetches.get(providerId);
  if (existing) return existing;

  const pending = fetchQuotaForProviderUncoalesced(providerId).finally(() => {
    if (pendingQuotaFetches.get(providerId) === pending) pendingQuotaFetches.delete(providerId);
  });
  pendingQuotaFetches.set(providerId, pending);
  return pending;
};
