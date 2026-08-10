import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchOpenCodeGoUsage } from './opencodeGoQuota';
import { readCredential } from './quotaCredentials';
import { getProviderAuth, updateProviderAuth } from './opencodeAuth';

type AuthEntry = Record<string, unknown> | string;
type AuthFile = Record<string, AuthEntry>;

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
};

type ProviderUsage = {
  windows: Record<string, UsageWindow>;
  models?: Record<string, ProviderUsage>;
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
  nextResetTime?: number;
  percentage?: number;
};

type ZaiPayload = {
  data?: {
    limits?: ZaiLimit[];
  };
};

type ZhipuaiTokensLimit = {
  type: 'TOKENS_LIMIT';
  unit?: number;
  number?: number;
  nextResetTime?: number;
  percentage?: number;
};

type ZhipuaiMcpTimeLimit = {
  type: 'TIME_LIMIT';
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{
    modelCode?: string;
    usage?: number;
  }>;
};

type ZhipuaiPayload = {
  data?: {
    limits?: Array<ZhipuaiTokensLimit | ZhipuaiMcpTimeLimit>;
  };
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

type CrofPayload = {
  usable_requests?: number | null;
  credits?: number | string;
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

export type ProviderResult = {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: ProviderUsage | null;
  fetchedAt: number;
  error?: string;
};

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

const XAI_USAGE_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_REFRESH_SKEW_MS = 120_000;
const XAI_DEFAULT_EXPIRES_IN_SECONDS = 3600;

type XaiAuthEntry = Record<string, unknown> & {
  type: 'oauth';
  access?: string;
  refresh?: string;
  expires?: unknown;
};

let xaiRefreshPromise: Promise<XaiAuthEntry> | null = null;


const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json'),
];

// OAuth Secret value used to init client
// Note: It's ok to save this in git because this is an installed application
// as described here: https://developers.google.com/identity/protocols/oauth2#installed
// "The process results in a client ID and, in some cases, a client secret,
// which you embed in the source code of your application. (In this context,
// the client secret is obviously not treated as a secret.)"
// ref: https://github.com/opgginc/opencode-bar

const ANTIGRAVITY_GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_GOOGLE_CLIENT_SECRET = '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';
const GEMINI_GOOGLE_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_GOOGLE_CLIENT_SECRET = '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';
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GOOGLE_PRIMARY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

const GOOGLE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
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
    return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS } as const;
  }

  return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
};

const ZAI_TOKEN_WINDOW_SECONDS: Record<number, number> = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60,
};

const readAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed) as AuthFile;
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
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

const toTimestamp = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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
}): ProviderResult => ({
  providerId: data.providerId,
  providerName: data.providerName,
  ok: data.ok,
  configured: data.configured,
  usage: data.usage ?? null,
  ...(data.error ? { error: data.error } : {}),
  fetchedAt: Date.now(),
});

const resolveXaiAuth = (): XaiAuthEntry | null => {
  const entry = getProviderAuth('xai');
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

const xaiAccessNeedsRefresh = (entry: XaiAuthEntry, now = Date.now()): boolean => {
  const access = asNonEmptyString(entry.access);
  if (!access) return true;

  const refreshDeadline = now + XAI_REFRESH_SKEW_MS;
  const storedExpiry = Number(entry.expires);
  if (Number.isFinite(storedExpiry) && storedExpiry <= refreshDeadline) {
    return true;
  }

  const jwtExpiry = jwtExpiryMilliseconds(access);
  return jwtExpiry !== null && jwtExpiry <= refreshDeadline;
};

const refreshXaiAuth = (entry: XaiAuthEntry): Promise<XaiAuthEntry> => {
  if (xaiRefreshPromise) return xaiRefreshPromise;

  const refreshToken = asNonEmptyString(entry.refresh);
  if (!refreshToken) {
    return Promise.reject(new Error('xAI OAuth refresh token is unavailable'));
  }

  const pending = (async () => {
    const response = await fetch(XAI_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new Error(`xAI OAuth refresh failed: ${response.status}`);
    }

    const responsePayload = payload ?? {};
    const access = asNonEmptyString(responsePayload.access_token);
    if (!access) {
      throw new Error('xAI OAuth refresh returned no access token');
    }

    const expiresIn = responsePayload.expires_in ?? XAI_DEFAULT_EXPIRES_IN_SECONDS;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      throw new Error('xAI OAuth refresh returned an invalid expiry');
    }

    const refreshed: XaiAuthEntry = {
      ...entry,
      type: 'oauth',
      access,
      refresh: asNonEmptyString(responsePayload.refresh_token) ?? refreshToken,
      expires: Date.now() + expiresIn * 1000,
    };

    // Validate the new access token before updating the existing secure auth file.
    updateProviderAuth('xai', refreshed);
    return refreshed;
  })();

  const settled = pending.finally(() => {
    if (xaiRefreshPromise === settled) {
      xaiRefreshPromise = null;
    }
  });
  xaiRefreshPromise = settled;
  return settled;
};

const getXaiAccessToken = async (entry: XaiAuthEntry): Promise<string> => {
  if (!xaiAccessNeedsRefresh(entry)) return entry.access!;
  return (await refreshXaiAuth(entry)).access!;
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

export const listConfiguredQuotaProviders = () => {
  let auth: AuthFile = {};
  try {
    auth = readAuthFile();
  } catch {
    // Managed credentials remain enumerable; unreadable auth cannot establish xAI configuration.
  }
  const configured = new Set<string>();
  if (readCredential('opencode-go')) configured.add('opencode-go');
  if (readCredential('ollama-cloud')) configured.add('ollama-cloud');
  if (readCredential('cursor')) configured.add('cursor');

  const anthropicAuth = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude']));
  if (anthropicAuth && ((anthropicAuth as Record<string, unknown>).access || (anthropicAuth as Record<string, unknown>).token)) {
    configured.add('claude');
  }

  const openaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt']));
  if (openaiAuth && ((openaiAuth as Record<string, unknown>).access || (openaiAuth as Record<string, unknown>).token)) {
    configured.add('codex');
  }

  if (resolveGeminiCliAuth(auth) || resolveAntigravityAuth()) {
    configured.add('google');
  }

  const zaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai']));
  if (zaiAuth && ((zaiAuth as Record<string, unknown>).key || (zaiAuth as Record<string, unknown>).token)) {
    configured.add('zai-coding-plan');
  }

  const zhipuaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan']));
  if (zhipuaiAuth && ((zhipuaiAuth as Record<string, unknown>).key || (zhipuaiAuth as Record<string, unknown>).token)) {
    configured.add('zhipuai-coding-plan');
  }

  const kimiAuth = normalizeAuthEntry(getAuthEntry(auth, ['kimi-for-coding', 'kimi']));
  if (kimiAuth && ((kimiAuth as Record<string, unknown>).key || (kimiAuth as Record<string, unknown>).token)) {
    configured.add('kimi-for-coding');
  }

  const minimaxAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-coding-plan']));
  if (minimaxAuth && ((minimaxAuth as Record<string, unknown>).key || (minimaxAuth as Record<string, unknown>).token)) {
    configured.add('minimax-coding-plan');
  }

  const minimaxCnAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-cn-coding-plan']));
  if (minimaxCnAuth && ((minimaxCnAuth as Record<string, unknown>).key || (minimaxCnAuth as Record<string, unknown>).token)) {
    configured.add('minimax-cn-coding-plan');
  }

  const openrouterAuth = normalizeAuthEntry(getAuthEntry(auth, ['openrouter']));
  if (openrouterAuth && ((openrouterAuth as Record<string, unknown>).key || (openrouterAuth as Record<string, unknown>).token)) {
    configured.add('openrouter');
  }

  const nanopgAuth = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt']));
  if (nanopgAuth && ((nanopgAuth as Record<string, unknown>).key || (nanopgAuth as Record<string, unknown>).token)) {
    configured.add('nano-gpt');
  }

  const copilotAuth = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot']));
  if (copilotAuth && ((copilotAuth as Record<string, unknown>).access || (copilotAuth as Record<string, unknown>).token)) {
    configured.add('github-copilot');
    configured.add('github-copilot-addon');
  }


  const waferAuth = normalizeAuthEntry(getAuthEntry(auth, ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai']));
  if (waferAuth && ((waferAuth as Record<string, unknown>).key || (waferAuth as Record<string, unknown>).token)) {
    configured.add('wafer');
  }

  const crofAuth = normalizeAuthEntry(getAuthEntry(auth, ['crof']));
  if (crofAuth && ((crofAuth as Record<string, unknown>).key || (crofAuth as Record<string, unknown>).token)) {
    configured.add('crof');
  }

  const neuralwattAuth = normalizeAuthEntry(getAuthEntry(auth, ['neuralwatt']));
  if (neuralwattAuth && ((neuralwattAuth as Record<string, unknown>).key || (neuralwattAuth as Record<string, unknown>).token)) {
    configured.add('neuralwatt');
  }

  const deepseekAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepseek']));
  if (deepseekAuth && ((deepseekAuth as Record<string, unknown>).key || (deepseekAuth as Record<string, unknown>).token)) {
    configured.add('deepseek');
  }

  let xaiAuth: XaiAuthEntry | null = null;
  try {
    xaiAuth = resolveXaiAuth();
  } catch {
    xaiAuth = null;
  }
  if (xaiAuth) {
    configured.add('xai');
  }

  return Array.from(configured);
};

const fetchCodexQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);
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
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as OpenAiUsagePayload;
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows: Record<string, UsageWindow> = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at),
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
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
          ? `$${formatMoney(balance)}`
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
        usedPercent: toNumber(spendLimit.used_percent),
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
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken ?? undefined,
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

const resolveGoogleAuthSources = (): GoogleAuthSource[] => {
  const auth = readAuthFile();
  const sources: GoogleAuthSource[] = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  const antigravityAuth = resolveAntigravityAuth();
  if (antigravityAuth) {
    sources.push(antigravityAuth);
  }

  return sources;
};

const resolveGoogleOAuthClient = (sourceId: GoogleAuthSource['sourceId']) => {
  if (sourceId === 'gemini') {
    return {
      clientId: GEMINI_GOOGLE_CLIENT_ID,
      clientSecret: GEMINI_GOOGLE_CLIENT_SECRET,
    };
  }

  return {
    clientId: ANTIGRAVITY_GOOGLE_CLIENT_ID,
    clientSecret: ANTIGRAVITY_GOOGLE_CLIENT_SECRET,
  };
};

const refreshGoogleAccessToken = async (refreshToken: string, clientId: string, clientSecret: string) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  return typeof data?.access_token === 'string' ? data.access_token : null;
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

    return await response.json() as GoogleQuotaBucketsPayload;
  } catch {
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const fetchGoogleModels = async (accessToken: string, projectId?: string) => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of GOOGLE_ENDPOINTS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...GOOGLE_HEADERS,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (response.ok) {
        return await response.json() as Record<string, unknown>;
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
  const authSources = resolveGoogleAuthSources();
  if (!authSources.length) {
    return buildResult({
      providerId: 'google',
      providerName: 'Google',
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
      const { clientId, clientSecret } = resolveGoogleOAuthClient(source.sourceId);
      accessToken = (await refreshGoogleAccessToken(source.refreshToken, clientId, clientSecret)) ?? undefined;
    }

    if (!accessToken) {
      sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
      continue;
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
        const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
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
        const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
        const resetAt = quotaInfo?.resetTime
          ? new Date(quotaInfo.resetTime).getTime()
          : null;
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
      providerName: 'Google',
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models',
    });
  }

  return buildResult({
    providerId: 'google',
    providerName: 'Google',
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined,
    },
  });
};

const fetchClaudeQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const fiveHour = (payload as Record<string, unknown>).five_hour as Record<string, unknown> | undefined;
    const sevenDay = (payload as Record<string, unknown>).seven_day as Record<string, unknown> | undefined;
    const sevenDaySonnet = (payload as Record<string, unknown>).seven_day_sonnet as Record<string, unknown> | undefined;
    const sevenDayOpus = (payload as Record<string, unknown>).seven_day_opus as Record<string, unknown> | undefined;

    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(fiveHour.resets_at),
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDay.resets_at),
      });
    }
    if (sevenDaySonnet) {
      windows['7d-sonnet'] = toUsageWindow({
        usedPercent: toNumber(sevenDaySonnet.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDaySonnet.resets_at),
      });
    }
    if (sevenDayOpus) {
      windows['7d-opus'] = toUsageWindow({
        usedPercent: toNumber(sevenDayOpus.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDayOpus.resets_at),
      });
    }

    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage: { windows },
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

  const addWindow = (label: string, snapshot?: Record<string, unknown>) => {
    if (!snapshot) return;
    const entitlement = toNumber(snapshot.entitlement);
    const remaining = toNumber(snapshot.remaining);
    const usedPercent = entitlement && remaining !== null
      ? Math.max(0, Math.min(100, 100 - (remaining / entitlement) * 100))
      : null;
    const valueLabel = entitlement !== null && remaining !== null
      ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left`
      : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel,
    });
  };

  addWindow('chat', quota.chat as Record<string, unknown> | undefined);
  addWindow('completions', quota.completions as Record<string, unknown> | undefined);
  addWindow('premium', quota.premium_interactions as Record<string, unknown> | undefined);

  return windows;
};

const fetchCopilotQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

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
    const response = await fetch('https://api.github.com/copilot_internal/user', {
      method: 'GET',
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

    const payload = await response.json() as Record<string, unknown>;
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

const fetchCopilotAddonQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'github-copilot-addon',
        providerName: 'GitHub Copilot Add-on',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows = buildCopilotWindows(payload);
    const premium = windows.premium ? { premium: windows.premium } : windows;

    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: true,
      configured: true,
      usage: { windows: premium },
    });
  } catch (error) {
    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// Kimi's weekly `usage` block reports `used`; its rate-limit `limits[].detail`
// blocks report `remaining` instead. Neither field is guaranteed present, so
// derive usedPercent from whichever one the API actually returned.
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

const fetchKimiQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['kimi-for-coding', 'kimi'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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
    const response = await fetch('https://api.kimi.com/coding/v1/usages', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'kimi-for-coding',
        providerName: 'Kimi for Coding',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (usage) {
      const limit = toNumber(usage.limit);
      const used = toNumber(usage.used);
      const remaining = toNumber(usage.remaining);
      const usedPercent = computeKimiUsedPercent(limit, used, remaining);
      windows.weekly = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt: toTimestamp(usage.resetTime),
      });
    }

    const limits = Array.isArray(payload.limits) ? payload.limits : [];
    for (const limit of limits) {
      const window = (limit as Record<string, unknown>)?.window as Record<string, unknown> | undefined;
      const detail = (limit as Record<string, unknown>)?.detail as Record<string, unknown> | undefined;
      const rawLabel = durationToLabel(window?.duration as number | undefined, window?.timeUnit as string | undefined);
      const windowSeconds = durationToSeconds(window?.duration as number | undefined, window?.timeUnit as string | undefined);
      const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel;
      const total = toNumber(detail?.limit);
      const used = toNumber(detail?.used);
      const remaining = toNumber(detail?.remaining);
      const usedPercent = computeKimiUsedPercent(total, used, remaining);
      windows[label] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt: toTimestamp(detail?.resetTime),
      });
    }

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
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, [data.providerId])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as Record<string, unknown>;
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

const parseOllamaSettingsHtml = (html: string) => {
  const windows: Record<string, UsageWindow> = {};
  const sessionMatch = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({
      usedPercent: toNumber(sessionMatch[1]),
      windowSeconds: null,
      resetAt: null,
    });
  }

  const weeklyMatch = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weeklyMatch[1]),
      windowSeconds: null,
      resetAt: null,
    });
  }

  const premiumMatch = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premiumMatch) {
    const used = toNumber(premiumMatch[1]);
    const total = toNumber(premiumMatch[2]);
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.premium = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${used ?? 0} / ${total ?? 0}`,
    });
  }

  return windows;
};

const fetchOllamaCloudQuota = async (): Promise<ProviderResult> => {
  const cookie = readCredential('ollama-cloud')?.cookie;

  if (!cookie) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://ollama.com/settings', {
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'ollama-cloud',
        providerName: 'Ollama Cloud',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows: parseOllamaSettingsHtml(await response.text()) },
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

const fetchCursorQuota = async (): Promise<ProviderResult> => {
  const accessToken = readCredential('cursor')?.accessToken;
  if (!accessToken) return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: false, error: 'Not configured' });
  try {
    const response = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    const plan = (payload.planUsage as Record<string, unknown> | undefined) ?? {};
    const usedPercent = toNumber(plan.totalPercentUsed);
    return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: true, configured: true, usage: { windows: { billing_cycle: toUsageWindow({ usedPercent, windowSeconds: null, resetAt: toTimestamp(payload.billingCycleEnd) }) } } });
  } catch (error) { return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' }); }
};

const fetchOpenRouterQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openrouter'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/credits', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const credits = payload.data as Record<string, unknown> | undefined;
    const totalCredits = toNumber(credits?.total_credits);
    const totalUsage = toNumber(credits?.total_usage);
    const remaining = totalCredits !== null && totalUsage !== null
      ? Math.max(0, totalCredits - totalUsage)
      : null;
    let valueLabel: string | null = null;
    if (remaining !== null && totalUsage !== null) {
      valueLabel = `$${formatMoney(remaining)} left · $${formatMoney(totalUsage)} spent`;
    }

    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: true,
      configured: true,
      usage: {
        windows: {
          credits: toUsageWindow({
            usedPercent: null,
            windowSeconds: null,
            resetAt: null,
            valueLabel,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};


const normalizeTimestamp = (value: unknown) => {
  if (typeof value !== 'number') return null;
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

const fetchZaiQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as ZaiPayload;
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
    const windows: Record<string, UsageWindow> = {};
    for (const tokensLimit of limits.filter((limit) => limit?.type === 'TOKENS_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(tokensLimit as Record<string, unknown>);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = tokensLimit.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
      const usedPercent = typeof tokensLimit.percentage === 'number' ? tokensLimit.percentage : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
      });
    }

    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      windows['MCP Tools'] = toUsageWindow({
        usedPercent: typeof mcpToolsTimeLimit.percentage === 'number' ? mcpToolsTimeLimit.percentage : null,
        windowSeconds: 30 * 24 * 60 * 60,
        resetAt: mcpToolsTimeLimit.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null,
      });
    }

    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: true,
      configured: true,
      usage: { windows },
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

const fetchZhipuaiCodingPlanQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as ZhipuaiPayload;
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const tokensLimit = limits.find((limit): limit is ZhipuaiTokensLimit => limit?.type === 'TOKENS_LIMIT');
    const mcpToolsTimeLimit = limits.find((limit): limit is ZhipuaiMcpTimeLimit => limit?.type === 'TIME_LIMIT');

    const windows: Record<string, UsageWindow> = {};

    // Handle TOKENS_LIMIT (5-hour window for token usage)
    if (tokensLimit) {
      const windowSeconds = resolveWindowSeconds(tokensLimit);
      const resetAt = tokensLimit?.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
      const usedPercent = typeof tokensLimit?.percentage === 'number' ? tokensLimit.percentage : null;

      windows['Tokens'] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? mcpToolsTimeLimit.percentage : null;

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

const NANO_GPT_DAILY_WINDOW_SECONDS = 86400;

const fetchNanoGptQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const period = payload.period as Record<string, unknown> | undefined;
    const daily = payload.daily as Record<string, unknown> | undefined;
    const monthly = payload.monthly as Record<string, unknown> | undefined;
    const state = (payload.state as string) ?? 'active';

    if (daily) {
      let usedPercent: number | null = null;
      const percentUsed = daily.percentUsed as number | undefined;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(daily.used);
        const limit = toNumber((daily.limit as number | undefined) ?? (daily.limits as Record<string, unknown>)?.daily);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp(daily.resetAt);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['daily'] = toUsageWindow({
        usedPercent,
        windowSeconds: NANO_GPT_DAILY_WINDOW_SECONDS,
        resetAt,
        valueLabel,
      });
    }

    if (monthly) {
      let usedPercent: number | null = null;
      const percentUsed = monthly.percentUsed as number | undefined;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(monthly.used);
        const limit = toNumber((monthly.limit as number | undefined) ?? (monthly.limits as Record<string, unknown>)?.monthly);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp((monthly.resetAt as string | number | undefined) ?? (period as Record<string, unknown>)?.currentPeriodEnd);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['monthly'] = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt,
        valueLabel,
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
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as WaferPayload;
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
    const usedPercent = hasOverage
      ? Math.max(0, usedPercentRaw ?? 0)
      : Math.max(0, Math.min(100, usedPercentRaw ?? 0));

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

const fetchNeuralwattQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['neuralwatt'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as NeuralwattPayload;
    const subscription = payload?.subscription ?? null;
    const inOverage = Boolean(subscription?.in_overage);
    const allowance = payload?.key?.allowance ?? null;
    const keyName = payload?.key?.name ?? null;
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
      // Window title is the localized period label (daily/weekly/monthly); key
      // name is attached via valueLabel for identification (wafer precedent).
      const periodKey = (period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'month')
        ? (period === 'month' ? 'monthly' : period)
        : 'billing_cycle';
      const labelName = typeof keyName === 'string' && keyName.trim() ? keyName.trim() : null;
      const resetAt = toTimestamp(allowance.reset_at);
      const windowSeconds = period ? neuralwattWindowSeconds(period) : null;
      windows[periodKey] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
        ...(labelName ? { valueLabel: labelName } : {}),
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

const CROF_USAGE_URL = 'https://crof.ai/usage_api/';

const fetchCrofQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['crof'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'crof',
      providerName: 'CrofAI',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(CROF_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'crof',
        providerName: 'CrofAI',
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with CrofAI'
          : `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as CrofPayload;
    const credits = toNumber(payload?.credits);
    const valueLabel = credits !== null ? `$${formatMoney(credits)}` : null;

    const windows: Record<string, UsageWindow> = {
      credits: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      }),
    };

    return buildResult({
      providerId: 'crof',
      providerName: 'CrofAI',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'crof',
      providerName: 'CrofAI',
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

const fetchDeepseekQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['deepseek'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

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

    const payload = await response.json() as DeepseekPayload;
    const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const balanceInfo = balanceInfos.find((info) => info?.currency === 'USD')
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

const fetchXaiQuota = async (): Promise<ProviderResult> => {
  try {
    const entry = resolveXaiAuth();
    if (!entry) {
      return buildResult({
        providerId: 'xai',
        providerName: 'xAI',
        ok: false,
        configured: false,
        error: 'Not configured',
      });
    }

    const accessToken = await getXaiAccessToken(entry);
    const response = await fetch(XAI_USAGE_ENDPOINT, {
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

    const parsed = parseXaiUsage(new Uint8Array(await response.arrayBuffer()));
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

export const fetchQuotaForProvider = async (providerId: string): Promise<ProviderResult> => {
  switch (providerId) {
    case 'claude':
      return fetchClaudeQuota();
    case 'codex':
      return fetchCodexQuota();
    case 'github-copilot':
      return fetchCopilotQuota();
    case 'github-copilot-addon':
      return fetchCopilotAddonQuota();
    case 'google':
      return fetchGoogleQuota();
    case 'kimi-for-coding':
      return fetchKimiQuota();
    case 'nano-gpt':
      return fetchNanoGptQuota();
    case 'minimax-coding-plan':
      return fetchMiniMaxCodingPlanQuota();
    case 'minimax-cn-coding-plan':
      return fetchMiniMaxCnCodingPlanQuota();
    case 'ollama-cloud':
      return fetchOllamaCloudQuota();
    case 'openrouter':
      return fetchOpenRouterQuota();
    case 'zai-coding-plan':
      return fetchZaiQuota();
    case 'zhipuai-coding-plan':
      return fetchZhipuaiCodingPlanQuota();
    case 'wafer':
      return fetchWaferQuota();
    case 'opencode-go': {
      const credential = readCredential('opencode-go') as { workspaceId: string; authCookie: string } | null;
      if (!credential) return buildResult({ providerId, providerName: 'OpenCode Go', ok: false, configured: false, error: 'Not configured' });
      try {
        return buildResult({ providerId, providerName: 'OpenCode Go', ok: true, configured: true, usage: { windows: await fetchOpenCodeGoUsage(credential) } });
      } catch (error) {
        return buildResult({ providerId, providerName: 'OpenCode Go', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
      }
    }
    case 'cursor':
      return fetchCursorQuota();
    case 'crof':
      return fetchCrofQuota();
    case 'deepseek':
      return fetchDeepseekQuota();
    case 'neuralwatt':
      return fetchNeuralwattQuota();
    case 'xai':
      return fetchXaiQuota();
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
