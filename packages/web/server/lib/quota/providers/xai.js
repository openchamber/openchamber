import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import { buildResult, toUsageWindow } from '../utils/index.js';

export const providerId = 'xai';
export const providerName = 'xAI';

const USAGE_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const REFRESH_SKEW_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EMPTY_GRPC_WEB_BODY = new Uint8Array([0, 0, 0, 0, 0]);

let refreshPromise = null;

const nonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readXaiAuth = () => {
  try {
    const entry = readAuthFile()?.xai;
    if (!entry || typeof entry !== 'object' || entry.type !== 'oauth') {
      return { entry: null, error: null };
    }
    if (!nonEmptyString(entry.access) && !nonEmptyString(entry.refresh)) {
      return { entry: null, error: null };
    }
    return { entry, error: null };
  } catch {
    return { entry: null, error: 'Failed to read xAI OAuth credentials' };
  }
};

const decodeJwtClaims = (token) => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const tokenNeedsRefresh = (entry) => {
  const access = nonEmptyString(entry.access);
  if (!access) return true;

  const refreshDeadline = Date.now() + REFRESH_SKEW_MS;
  const storedExpiry = Number(entry.expires);
  if (Number.isFinite(storedExpiry) && storedExpiry <= refreshDeadline) return true;

  const jwtExpiry = Number(decodeJwtClaims(access)?.exp) * 1000;
  return Number.isFinite(jwtExpiry) && jwtExpiry <= refreshDeadline;
};

const refreshXaiOauth = async (entry) => {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = nonEmptyString(entry.refresh);
      if (!refreshToken) {
        throw new Error('xAI OAuth entry has no usable refresh token');
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(`xAI OAuth refresh failed with HTTP ${response.status}`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('xAI OAuth refresh returned invalid JSON');
      }

      const access = nonEmptyString(payload?.access_token);
      if (!access) {
        throw new Error('xAI OAuth refresh returned no access token');
      }

      const expiresIn = payload?.expires_in ?? 3600;
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
        throw new Error('xAI OAuth refresh returned an invalid expiry');
      }
      const expires = Date.now() + expiresIn * 1000;
      const refreshed = {
        ...entry,
        type: 'oauth',
        access,
        refresh: nonEmptyString(payload?.refresh_token) ?? refreshToken,
        expires
      };

      const auth = readAuthFile();
      auth.xai = refreshed;
      writeAuthFile(auth);
      return refreshed;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
};

const ensureFreshAccess = async (entry) => {
  if (!tokenNeedsRefresh(entry)) return entry;
  if (!nonEmptyString(entry.refresh)) {
    throw new Error('xAI OAuth access token is expired and has no usable refresh token');
  }
  return refreshXaiOauth(entry);
};

const readVarint = (bytes, state) => {
  let value = 0n;
  for (let shift = 0n; state.index < bytes.length && shift < 64n; shift += 7n) {
    const byte = bytes[state.index++];
    if (shift === 63n && (byte & 0x7e) !== 0) return null;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
  }
  return null;
};

const samePath = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
// CodexBar observes both the flat billing message and the response envelope.
const USAGE_PERCENT_PATHS = [[1], [1, 1]];
const hasPath = (paths, candidate) => paths.some((path) => samePath(path, candidate));

const scanProtobuf = (bytes, path = [], depth = 0, state = { index: 0, order: 0 }) => {
  const fixed32Fields = [];
  const varintFields = [];

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

const parseFrames = (bytes) => {
  if (bytes.length < 5 || (bytes[0] & 0x7f) !== 0) return null;
  const messages = [];
  const trailerStatuses = [];
  let trailerStarted = false;
  let index = 0;

  while (index < bytes.length) {
    if (index + 5 > bytes.length) return false;
    const flags = bytes[index++];
    if ((flags & 0x7f) !== 0) return false;
    const isTrailer = (flags & 0x80) !== 0;
    if (trailerStarted && !isTrailer) return false;
    const length = (bytes[index] * 0x1000000)
      + (bytes[index + 1] << 16)
      + (bytes[index + 2] << 8)
      + bytes[index + 3];
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

const parseGrpcTrailerStatus = (bytes) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let status = null;
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

const looksLikeProtobuf = (bytes) => {
  if (!bytes.length) return false;
  const fieldNumber = bytes[0] >> 3;
  const wireType = bytes[0] & 0x07;
  return fieldNumber > 0 && [0, 1, 2, 5].includes(wireType);
};

const parseUsage = (bytes) => {
  const framed = parseFrames(bytes);
  if (framed === false) throw new Error('xAI billing returned malformed gRPC-web framing');
  const payloads = framed ? framed.messages : (looksLikeProtobuf(bytes) ? [bytes] : []);
  if (framed) {
    for (const status of framed.trailerStatuses) {
      if (status !== 0) throw new Error(`xAI billing RPC failed with status ${status}`);
    }
  }
  if (payloads.length === 0) throw new Error('xAI billing returned an empty protobuf response');

  const scan = { fixed32Fields: [], varintFields: [] };
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
  const usedPercent = percentages.length > 0 ? percentages[0].value : null;

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

const fetchUsage = async (accessToken) => {
  const response = await fetch(USAGE_URL, {
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

export const isConfigured = () => Boolean(readXaiAuth().entry);

export const fetchQuota = async () => {
  const { entry, error: authError } = readXaiAuth();
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
    const freshEntry = await ensureFreshAccess(entry);
    const accessToken = nonEmptyString(freshEntry.access);
    if (!accessToken) throw new Error('xAI OAuth entry has no usable access token');
    const usage = await fetchUsage(accessToken);

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
