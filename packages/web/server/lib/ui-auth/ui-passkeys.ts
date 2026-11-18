import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from '../shared/http-contracts.js';

export interface PasskeyOptions {
  passwordBinding?: string;
  readSettingsFromDiskMigrated?: (() => Promise<{ publicOrigin?: unknown }>) | undefined;
  storeFile?: string;
  rpName?: string;
  challengeTtlMs?: number;
}

export interface StoredPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  label: string;
  customLabel?: string | null;
  rpID: string;
}

interface PasskeyStore {
  version: number;
  userID: string;
  passwordBinding: string | undefined;
  passkeys: StoredPasskey[];
}

interface Challenge {
  challenge: string;
  expectedOrigins: string[];
  expectedRPIDs: string[];
  createdAt: number;
  expiresAt: number;
}

interface RegistrationChallenge extends Challenge {
  rpID: string;
  label: string;
}

interface PasskeyInput {
  id?: unknown;
  publicKey?: unknown;
  rpID?: unknown;
  counter?: unknown;
  transports?: unknown;
  deviceType?: unknown;
  backedUp?: unknown;
  createdAt?: unknown;
  lastUsedAt?: unknown;
  label?: unknown;
  customLabel?: unknown;
}

interface StoreInput {
  userID?: unknown;
  passwordBinding?: unknown;
  passkeys?: unknown;
}

interface VerificationInput {
  requestId?: unknown;
  response?: unknown;
}

const hasProperties = (value: unknown): value is PasskeyInput & StoreInput & VerificationInput => value != null;
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isObject = (value: unknown): value is PasskeyInput => Boolean(value) && typeof value === 'object';
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const errorDetails = (value: unknown): value is { message?: unknown } => value != null;

let webauthnPending: Promise<typeof import('@simplewebauthn/server')> | undefined;
const loadWebAuthn = () => {
  webauthnPending ??= import('@simplewebauthn/server');
  return webauthnPending;
};

const DEFAULT_STORE_VERSION = 1;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RP_NAME = 'OpenChamber';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const PASSKEY_STORE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'ui-passkeys.json');

const createUserId = () => crypto.randomBytes(32).toString('base64url');

const decodeUserId = (value: StoreInput['userID']) => {
  if (!isString(value) || !value) {
    return null;
  }

  try {
    return Uint8Array.from(Buffer.from(value, 'base64url'));
  } catch {
    return null;
  }
};

const normalizeLabel = (value: PasskeyInput['label'], fallback: string) => {
  if (!isString(value)) {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 120) : fallback;
};

const normalizeOptionalLabel = (value: PasskeyInput['label']) => normalizeLabel(value, '') || null;

const normalizeHost = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end).toLowerCase() : trimmed.toLowerCase();
  }

  const colonIndex = trimmed.indexOf(':');
  return (colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed).toLowerCase();
};

const isLocalRpId = (rpID: string) => rpID === 'localhost' || rpID === '127.0.0.1' || rpID === '::1';

const getCurrentRequestOrigin = (req: Request) => {
  const forwardedProto = isString(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'].split(',')[0]?.trim().toLowerCase() ?? ''
    : '';
  const protocol = forwardedProto || (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http');
  const forwardedHost = isString(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'].split(',')[0]?.trim() ?? ''
    : '';
  const host = forwardedHost || (isString(req.headers.host) ? req.headers.host.trim() : '');

  if (!host) {
    return '';
  }

  return `${protocol}://${host}`;
};

const getCurrentRpId = (req: Request) => {
  const forwardedHost = isString(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'].split(',')[0]?.trim() ?? ''
    : '';
  const host = forwardedHost || (isString(req.headers.host) ? req.headers.host.trim() : '');
  return normalizeHost(host || req.hostname || '');
};

const parseStoredPasskey = (record: StoreInput['passkeys']): StoredPasskey | null => {
  if (!isObject(record)) {
    return null;
  }

  if (!isString(record.id) || !isString(record.publicKey) || !isString(record.rpID)) {
    return null;
  }

  return {
    id: record.id,
    publicKey: record.publicKey,
    counter: isNumber(record.counter) && Number.isFinite(record.counter) ? record.counter : 0,
    transports: isArray(record.transports)
      ? record.transports.filter(isString)
      : [],
    deviceType: isString(record.deviceType) ? record.deviceType : 'singleDevice',
    backedUp: record.backedUp === true,
    createdAt: isNumber(record.createdAt) ? record.createdAt : Date.now(),
    lastUsedAt: isNumber(record.lastUsedAt) ? record.lastUsedAt : null,
    label: normalizeLabel(record.label, 'Unnamed device'),
    customLabel: normalizeOptionalLabel(record.customLabel),
    rpID: record.rpID,
  };
};

export const createUiPasskeys = ({
  passwordBinding,
  readSettingsFromDiskMigrated,
  storeFile = PASSKEY_STORE_FILE,
  rpName = DEFAULT_RP_NAME,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
}: PasskeyOptions = {}) => {
  const registrationChallenges = new Map<string, RegistrationChallenge>();
  const authenticationChallenges = new Map<string, Challenge>();

  const ensureStoreDirectory = () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  };

  const persistStore = (store: PasskeyStore) => {
    ensureStoreDirectory();
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
  };

  const createEmptyStore = (): PasskeyStore => ({
    version: DEFAULT_STORE_VERSION,
    userID: createUserId(),
    passwordBinding,
    passkeys: [],
  });

  const loadStore = () => {
    let store = createEmptyStore();

    try {
      if (fs.existsSync(storeFile)) {
        const raw = fs.readFileSync(storeFile, 'utf8');
        const input: unknown = JSON.parse(raw);
        const parsed = hasProperties(input) ? input : undefined;
        store = {
          version: DEFAULT_STORE_VERSION,
          userID: isString(parsed?.userID) && decodeUserId(parsed.userID) ? parsed.userID : store.userID,
          passwordBinding: isString(parsed?.passwordBinding) ? parsed.passwordBinding : '',
          passkeys: isArray(parsed?.passkeys) ? parsed.passkeys.map(parseStoredPasskey).filter((passkey) => passkey !== null) : [],
        };
      }
    } catch (error) {
      console.warn('[UI Passkeys] Failed to read passkey store:', (errorDetails(error) ? error.message : undefined) || error);
    }

    if (!passwordBinding) {
      if (store.passkeys.length > 0 || store.passwordBinding) {
        store = { ...store, passkeys: [], passwordBinding: '' };
        persistStore(store);
      }
      return store;
    }

    if (store.passwordBinding !== passwordBinding) {
        store = {
          version: DEFAULT_STORE_VERSION,
          userID: store.userID || createUserId(),
          passwordBinding,
          passkeys: [],
        };
      persistStore(store);
      return store;
    }

    if (!fs.existsSync(storeFile)) {
      persistStore(store);
    }

    return store;
  };

  const cleanupChallengeMap = <T extends Challenge>(map: Map<string, T>) => {
    const now = Date.now();
    for (const [requestId, record] of map.entries()) {
      if (!record || now >= record.expiresAt) {
        map.delete(requestId);
      }
    }
  };

  const buildOriginCandidates = async (req: Request) => {
    const origins = new Set<string>();
    const currentOrigin = getCurrentRequestOrigin(req);
    if (currentOrigin) {
      origins.add(currentOrigin);
    }

    try {
      const settings = await readSettingsFromDiskMigrated?.();
      if (isString(settings?.publicOrigin) && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
      void 0;
    }

    return Array.from(origins);
  };

  const assertEnabled = () => {
    if (!passwordBinding) {
      const error: Error & { statusCode?: number } = new Error('Passkeys require UI password protection to be enabled');
      error.statusCode = 400;
      throw error;
    }
  };

  const getPasskeysForRpId = (store: PasskeyStore, rpID: string) => store.passkeys.filter((passkey) => passkey.rpID === rpID);

  const getStatus = (req: Request) => {
    const store = loadStore();
    const rpID = getCurrentRpId(req);
    return {
      enabled: Boolean(passwordBinding),
      hasPasskeys: Boolean(rpID) && getPasskeysForRpId(store, rpID).length > 0,
      passkeyCount: rpID ? getPasskeysForRpId(store, rpID).length : 0,
      rpID,
    };
  };

  const listPasskeys = (req: Request) => {
    assertEnabled();

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    if (!rpID) {
      return [];
    }

    return getPasskeysForRpId(store, rpID).map((passkey) => ({
      id: passkey.id,
      label: passkey.customLabel ?? passkey.label,
      customLabel: passkey.customLabel,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    }));
  };

  const revokePasskey = (req: Request, passkeyId: PasskeyInput['id']) => {
    assertEnabled();

    const normalizedPasskeyId = isString(passkeyId) ? passkeyId.trim() : '';
    if (!normalizedPasskeyId) {
      const error: Error & { statusCode?: number } = new Error('Passkey ID is required');
      error.statusCode = 400;
      throw error;
    }

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    const existingPasskey = store.passkeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID);

    if (!existingPasskey) {
      const error: Error & { statusCode?: number } = new Error('Passkey not found for this host');
      error.statusCode = 404;
      throw error;
    }

    const nextPasskeys = store.passkeys.filter((passkey) => !(passkey.id === normalizedPasskeyId && passkey.rpID === rpID));
    persistStore({
      ...store,
      passwordBinding,
      passkeys: nextPasskeys,
    });

    return {
      revoked: true,
      passkeyCount: nextPasskeys.filter((passkey) => passkey.rpID === rpID).length,
    };
  };

  const renamePasskey = (req: Request, passkeyId: PasskeyInput['id'], label: PasskeyInput['label']) => {
    assertEnabled();

    const normalizedPasskeyId = passkeyId ? `${passkeyId}`.trim() : '';
    if (!normalizedPasskeyId) {
      const error: Error & { statusCode?: number } = new Error('Passkey ID is required');
      error.statusCode = 400;
      throw error;
    }

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    const existingPasskey = store.passkeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID);

    if (!existingPasskey) {
      const error: Error & { statusCode?: number } = new Error('Passkey not found for this host');
      error.statusCode = 404;
      throw error;
    }

    const customLabel = normalizeOptionalLabel(label);
    const nextPasskeys = store.passkeys.map((passkey) => (
      passkey.id === normalizedPasskeyId && passkey.rpID === rpID
        ? { ...passkey, customLabel }
        : passkey
    ));

    persistStore({
      ...store,
      passwordBinding,
      passkeys: nextPasskeys,
    });

    const updatedPasskey = nextPasskeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID) || existingPasskey;

    return {
      renamed: true,
      passkey: {
        id: updatedPasskey.id,
        label: updatedPasskey.customLabel ?? updatedPasskey.label,
        customLabel: updatedPasskey.customLabel,
        createdAt: updatedPasskey.createdAt,
        lastUsedAt: updatedPasskey.lastUsedAt,
        deviceType: updatedPasskey.deviceType,
        backedUp: updatedPasskey.backedUp,
      },
    };
  };

  const clearAllPasskeys = () => {
    assertEnabled();

    const store = loadStore();
    const clearedCount = store.passkeys.length;
    persistStore({
      ...store,
      userID: crypto.randomBytes(32).toString('base64url'),
      passwordBinding,
      passkeys: [],
    });

    return {
      cleared: true,
      clearedCount,
    };
  };

  const beginRegistration = async (req: Request, { label }: { label?: string } = {}) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const rpID = getCurrentRpId(req);
    if (!rpID) {
      const error: Error & { statusCode?: number } = new Error('Unable to resolve a valid passkey host for this request');
      error.statusCode = 400;
      throw error;
    }

    const currentOrigin = getCurrentRequestOrigin(req);
    if (!currentOrigin) {
      const error: Error & { statusCode?: number } = new Error('Unable to resolve a valid passkey origin for this request');
      error.statusCode = 400;
      throw error;
    }

    const store = loadStore();
    const userID = decodeUserId(store.userID);
    if (!userID) {
      const error: Error & { statusCode?: number } = new Error('Passkey storage is invalid. Please try again.');
      error.statusCode = 500;
      throw error;
    }

    const options = await (await loadWebAuthn()).generateRegistrationOptions({
      rpName,
      rpID,
      userID,
      userName: 'openchamber-ui',
      userDisplayName: 'OpenChamber UI',
      attestationType: 'none',
      excludeCredentials: getPasskeysForRpId(store, rpID).map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    registrationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(req),
      expectedRPIDs: [rpID],
      rpID,
      label: normalizeLabel(label, 'This device'),
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishRegistration = async (input: VerificationInput['response']) => {
    const payload = hasProperties(input) ? input : undefined;
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const store = loadStore();
    const requestId = isString(payload?.requestId) ? payload.requestId : '';
    const response = payload?.response;

    const matchingRecord = requestId ? registrationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error: Error & { statusCode?: number } = new Error('Passkey setup has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    registrationChallenges.delete(requestId);

    const verification = await (await loadWebAuthn()).verifyRegistrationResponse({
      response,
      expectedChallenge: matchingRecord.challenge,
      expectedOrigin: matchingRecord.expectedOrigins,
      expectedRPID: matchingRecord.expectedRPIDs,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      const error: Error & { statusCode?: number } = new Error('Passkey registration could not be verified');
      error.statusCode = 400;
      throw error;
    }

    const {
      credential,
      credentialDeviceType,
      credentialBackedUp,
    } = verification.registrationInfo;

    const nextPasskeys = store.passkeys.filter((passkey) => passkey.id !== credential.id);
    nextPasskeys.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: isArray(credential.transports) ? credential.transports.filter(isString) : [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: Date.now(),
      lastUsedAt: null,
      label: matchingRecord.label,
      rpID: matchingRecord.rpID,
    });

    persistStore({
      ...store,
      passwordBinding,
      passkeys: nextPasskeys,
    });

    return {
      verified: true,
      passkeyCount: nextPasskeys.filter((passkey) => passkey.rpID === matchingRecord.rpID).length,
    };
  };

  const beginAuthentication = async (req: Request) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    const passkeys = getPasskeysForRpId(store, rpID);

    if (!rpID || passkeys.length === 0) {
      const error: Error & { statusCode?: number } = new Error('No passkeys are registered for this host yet');
      error.statusCode = 404;
      throw error;
    }

    const options = await (await loadWebAuthn()).generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    authenticationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(req),
      expectedRPIDs: [rpID],
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishAuthentication = async (input: VerificationInput['response']) => {
    const payload = hasProperties(input) ? input : undefined;
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const requestId = isString(payload?.requestId) ? payload.requestId : '';
    const response = payload?.response;
    const store = loadStore();
    const passkey = store.passkeys.find((item) => item.id === (hasProperties(response) ? response.id : undefined));

    if (!passkey) {
      const error: Error & { statusCode?: number } = new Error('That passkey is not registered for this OpenChamber instance');
      error.statusCode = 404;
      throw error;
    }

    const matchingRecord = requestId ? authenticationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error: Error & { statusCode?: number } = new Error('Passkey sign-in has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    authenticationChallenges.delete(requestId);

    const verification = await (await loadWebAuthn()).verifyAuthenticationResponse({
      response,
      expectedChallenge: matchingRecord.challenge,
      expectedOrigin: matchingRecord.expectedOrigins,
      expectedRPID: matchingRecord.expectedRPIDs,
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.authenticationInfo) {
      const error: Error & { statusCode?: number } = new Error('Passkey sign-in could not be verified');
      error.statusCode = 400;
      throw error;
    }

    const nextPasskeys = store.passkeys.map((item) => (
      item.id === passkey.id
        ? {
            ...item,
            counter: verification.authenticationInfo.newCounter,
            lastUsedAt: Date.now(),
          }
        : item
    ));

    persistStore({
      ...store,
      passwordBinding,
      passkeys: nextPasskeys,
    });

    return { verified: true };
  };

  const dispose = () => {
    registrationChallenges.clear();
    authenticationChallenges.clear();
  };

  return {
    enabled: Boolean(passwordBinding),
    getStatus,
    listPasskeys,
    revokePasskey,
    renamePasskey,
    clearAllPasskeys,
    beginRegistration,
    finishRegistration,
    beginAuthentication,
    finishAuthentication,
    dispose,
    isLocalRpId,
  };
};
