import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthEntry, LegacyAuthFile } from '../../opencode/auth.js';
import { buildResult, toUsageWindow } from '../utils/index.js';
import { asNonEmptyString as nonEmptyString } from '../../shared/guards.js';

export const providerId = 'xai';
export const providerName = 'xAI';

const USAGE_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const ACCESS_EXPIRY_SKEW_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EMPTY_GRPC_WEB_BODY = new Uint8Array([0, 0, 0, 0, 0]);

type XaiOAuthEntry = Extract<LegacyAuthEntry, { type: 'oauth' }>;
type ReadXaiAuth = () => LegacyAuthFile | Promise<LegacyAuthFile>;

export interface XaiQuotaDependencies {
  readAuth?: ReadXaiAuth;
  fetchImpl?: typeof fetch;
}

interface ProtobufState {
  index: number;
  order: number;
}

interface ProtobufScan {
  fixed32Fields: { path: number[]; value: number; order: number }[];
  varintFields: { path: number[]; value: bigint }[];
}

const jwtClaims = z.looseObject({ exp: z.unknown() });

const xaiEntryOf = (auth: LegacyAuthFile | null | undefined) => {
  const entry = auth?.xai;
  if (entry?.type !== 'oauth') return null;
  if (!nonEmptyString(entry.access) && !nonEmptyString(entry.refresh)) return null;
  return entry;
};

const readXaiAuth = async (readAuth: ReadXaiAuth) => {
  try {
    return { entry: xaiEntryOf(await readAuth()), error: null };
  } catch {
    return { entry: null, error: 'Failed to read xAI OAuth credentials' };
  }
};

const decodeJwtClaims = (token: string) => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const parsed = jwtClaims.safeParse(claims);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const accessTokenExpired = (entry: XaiOAuthEntry) => {
  const access = nonEmptyString(entry.access);
  if (!access) return true;

  const expiryDeadline = Date.now() + ACCESS_EXPIRY_SKEW_MS;
  const storedExpiry = Number(entry.expires);
  if (Number.isFinite(storedExpiry) && storedExpiry <= expiryDeadline) return true;

  const jwtExpiry = Number(decodeJwtClaims(access)?.exp) * 1000;
  return Number.isFinite(jwtExpiry) && jwtExpiry <= expiryDeadline;
};

const requireFreshAccess = (entry: XaiOAuthEntry) => {
  const access = nonEmptyString(entry.access);
  if (!access || accessTokenExpired(entry)) {
    throw new Error('xAI access token expired — send a Grok message or re-authorize');
  }
  return access;
};

const readVarint = (bytes: Uint8Array, state: Pick<ProtobufState, 'index'>) => {
  let value = 0n;
  for (let shift = 0n; state.index < bytes.length && shift < 64n; shift += 7n) {
    const byte = bytes[state.index++];
    if (byte === undefined) return null;
    if (shift === 63n && (byte & 0x7e) !== 0) return null;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
  }
  return null;
};

const samePath = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => value === right[index]);
const USAGE_PERCENT_PATHS = [[1], [1, 1]];
const hasPath = (paths: number[][], candidate: number[]) => paths.some((path) => samePath(path, candidate));

const scanProtobuf = (bytes: Uint8Array, path: number[] = [], depth = 0, state: ProtobufState = { index: 0, order: 0 }): ProtobufScan | false => {
  const fixed32Fields: ProtobufScan['fixed32Fields'] = [];
  const varintFields: ProtobufScan['varintFields'] = [];

  while (state.index < bytes.length) {
    const key = readVarint(bytes, state);
    if (key === null || key === 0n) return false;
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 0x07n);
    if (!fieldNumber || fieldNumber > 0x1fffffff) return false;
    const fieldPath = [...path, fieldNumber];

    if (wireType === 0) {
      const value = readVarint(bytes, state);
      if (value === null) return false;
      varintFields.push({ path: fieldPath, value });
      continue;
    }

    if (wireType === 1) {
      if (state.index + 8 > bytes.length) return false;
      state.index += 8;
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(bytes, state);
      if (length === null || length > BigInt(bytes.length - state.index)) return false;
      const end = state.index + Number(length);
      if (depth >= 4 && length !== 0n) return false;
      if (depth < 4) {
        const nestedState = { index: 0, order: state.order };
        const nested = scanProtobuf(bytes.slice(state.index, end), fieldPath, depth + 1, nestedState);
        if (nested === false) return false;
        fixed32Fields.push(...nested.fixed32Fields);
        varintFields.push(...nested.varintFields);
        state.order = nestedState.order;
      }
      state.index = end;
      continue;
    }

    if (wireType === 5) {
      if (state.index + 4 > bytes.length) return false;
      const value = Buffer.from(bytes.slice(state.index, state.index + 4)).readFloatLE(0);
      fixed32Fields.push({ path: fieldPath, value, order: state.order++ });
      state.index += 4;
      continue;
    }

    return false;
  }

  return { fixed32Fields, varintFields };
};

const parseFrames = (bytes: Uint8Array) => {
  const first = bytes[0];
  if (bytes.length < 5 || first === undefined || (first & 0x7f) !== 0) return null;
  const messages = [];
  const trailerStatuses = [];
  let trailerStarted = false;
  let index = 0;

  while (index < bytes.length) {
    if (index + 5 > bytes.length) return false;
    const flags = bytes[index++];
    if (flags === undefined) return false;
    if ((flags & 0x7f) !== 0) return false;
    const isTrailer = (flags & 0x80) !== 0;
    if (trailerStarted && !isTrailer) return false;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(index);
    index += 4;
    const end = index + length;
    if (end > bytes.length) return false;
    const payload = bytes.slice(index, end);
    if (isTrailer) {
      trailerStarted = true;
      const status = parseGrpcTrailerStatus(payload);
      if (status === null) return false;
      trailerStatuses.push(status);
    } else {
      messages.push(payload);
    }
    index = end;
  }

  return { messages, trailerStatuses };
};

const parseGrpcTrailerStatus = (bytes: Uint8Array) => {
  let text;
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

const looksLikeProtobuf = (bytes: Uint8Array) => {
  const first = bytes[0];
  if (!bytes.length || first === undefined) return false;
  const fieldNumber = first >> 3;
  const wireType = first & 0x07;
  return fieldNumber > 0 && [0, 1, 2, 5].includes(wireType);
};

const parseUsage = (bytes: Uint8Array) => {
  const framed = parseFrames(bytes);
  if (framed === false) throw new Error('xAI billing returned malformed gRPC-web framing');
  const payloads = framed ? framed.messages : (looksLikeProtobuf(bytes) ? [bytes] : []);
  if (framed) {
    for (const status of framed.trailerStatuses) {
      if (status !== 0) throw new Error(`xAI billing RPC failed with status ${status}`);
    }
  }
  if (payloads.length === 0) throw new Error('xAI billing returned an empty protobuf response');

  const scan: ProtobufScan = { fixed32Fields: [], varintFields: [] };
  for (const payload of payloads) {
    const result = scanProtobuf(payload);
    if (result === false) throw new Error('xAI billing returned malformed protobuf');
    scan.fixed32Fields.push(...result.fixed32Fields);
    scan.varintFields.push(...result.varintFields);
  }

  const percentages = scan.fixed32Fields
    .filter((field) => (
      hasPath(USAGE_PERCENT_PATHS, field.path)
        && Number.isFinite(field.value)
        && field.value >= 0
        && field.value <= 100
    ))
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order);
  const usedPercent = percentages[0]?.value ?? null;

  const resetCandidates = scan.varintFields
    .filter((field) => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n)
    .map((field) => ({ ...field, seconds: Number(field.value) }))
    .map((field) => ({ ...field, resetAt: field.seconds * 1000 }))
    .filter((field) => field.resetAt > Date.now());
  const preferredReset = resetCandidates.filter((field) => samePath(field.path, [1, 5, 1]));
  const resetAt = (preferredReset.length > 0 ? preferredReset : resetCandidates)
    .sort((left, right) => left.resetAt - right.resetAt)[0]?.resetAt ?? null;
  const hasUsagePeriod = scan.varintFields.some((field) => (
    (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6)
      || (samePath(field.path, [1, 8, 1]) && (field.value === 1n || field.value === 2n))
  ));

  if (usedPercent === null && scan.fixed32Fields.length === 0 && resetAt !== null && hasUsagePeriod) {
    return { usedPercent: 0, resetAt };
  }
  if (usedPercent === null) throw new Error('xAI billing response had no usable current-period usage');
  return { usedPercent, resetAt };
};

const fetchUsage = async (accessToken: string, fetchImpl: typeof fetch) => {
  const response = await fetchImpl(USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
      Accept: '*/*',
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      'User-Agent': 'OpenChamber'
    },
    body: EMPTY_GRPC_WEB_BODY,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const headerStatus = response.headers.get('grpc-status');
  if (headerStatus !== null) {
    if (!/^\d+$/.test(headerStatus.trim())) throw new Error('xAI billing returned malformed gRPC status');
    const status = Number(headerStatus.trim());
    if (!Number.isSafeInteger(status)) throw new Error('xAI billing returned malformed gRPC status');
    if (status !== 0) throw new Error(`xAI billing RPC failed with status ${status}`);
  }
  if (!response.ok) throw new Error(`xAI billing request failed with HTTP ${response.status}`);
  return parseUsage(new Uint8Array(await response.arrayBuffer()));
};

export const isConfigured = (auth: LegacyAuthFile | null | undefined) => Boolean(xaiEntryOf(auth));

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: XaiQuotaDependencies = {}) => {
  const { entry, error: authError } = await readXaiAuth(readAuth);
  if (authError) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: authError
    });
  }
  if (!entry) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const accessToken = requireFreshAccess(entry);
    const usage = await fetchUsage(accessToken, fetchImpl);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          billing_cycle: toUsageWindow({
            usedPercent: usage.usedPercent,
            windowSeconds: null,
            resetAt: usage.resetAt
          })
        }
      }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
