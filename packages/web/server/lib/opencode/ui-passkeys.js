import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const DEFAULT_STORE_VERSION = 1;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RP_NAME = 'OpenChamber';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const PASSKEY_STORE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'ui-passkeys.json');

const createUserId = () => crypto.randomBytes(32).toString('base64url');

const decodeUserId = (value) => {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    return Uint8Array.from(Buffer.from(value, 'base64url'));
  } catch {
    return null;
  }
};

const normalizeLabel = (value, fallback) => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 120) : fallback;
};

const normalizeHost = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

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

const isLocalRpId = (rpID) => rpID === 'localhost' || rpID === '127.0.0.1' || rpID === '::1';

const getCurrentRequestOrigin = (req) => {
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

  if (!host) {
    return '';
  }

  return `${protocol}://${host}`;
};

const getCurrentRpId = (req) => {
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');
  return normalizeHost(host || req.hostname || '');
};

const parseStoredPasskey = (record) => {
  if (!record || typeof record !== 'object') {
    return null;
  }

  if (typeof record.id !== 'string' || typeof record.publicKey !== 'string' || typeof record.rpID !== 'string') {
    return null;
  }

  return {
    id: record.id,
    publicKey: record.publicKey,
    counter: typeof record.counter === 'number' && Number.isFinite(record.counter) ? record.counter : 0,
    transports: Array.isArray(record.transports)
      ? record.transports.filter((value) => typeof value === 'string')
      : [],
    deviceType: typeof record.deviceType === 'string' ? record.deviceType : 'singleDevice',
    backedUp: record.backedUp === true,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null,
    label: normalizeLabel(record.label, 'Unnamed device'),
    rpID: record.rpID,
  };
};

export const createUiPasskeys = ({
  passwordBinding,
  readSettingsFromDiskMigrated,
  storeFile = PASSKEY_STORE_FILE,
  rpName = DEFAULT_RP_NAME,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
} = {}) => {
  const registrationChallenges = new Map();
  const authenticationChallenges = new Map();

  const ensureStoreDirectory = () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  };

  const persistStore = (store) => {
    ensureStoreDirectory();
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
  };

  const createEmptyStore = () => ({
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
        const parsed = JSON.parse(raw);
        store = {
          version: DEFAULT_STORE_VERSION,
          userID: decodeUserId(parsed?.userID) ? parsed.userID : store.userID,
          passwordBinding: typeof parsed?.passwordBinding === 'string' ? parsed.passwordBinding : '',
          passkeys: Array.isArray(parsed?.passkeys) ? parsed.passkeys.map(parseStoredPasskey).filter(Boolean) : [],
        };
      }
    } catch (error) {
      console.warn('[UI Passkeys] Failed to read passkey store:', error?.message || error);
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

  const cleanupChallengeMap = (map) => {
    const now = Date.now();
    for (const [requestId, record] of map.entries()) {
      if (!record || now >= record.expiresAt) {
        map.delete(requestId);
      }
    }
  };

  const buildOriginCandidates = async (req) => {
    const origins = new Set();
    const currentOrigin = getCurrentRequestOrigin(req);
    if (currentOrigin) {
      origins.add(currentOrigin);
    }

    try {
      const settings = await readSettingsFromDiskMigrated?.();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
    }

    return Array.from(origins);
  };

  const assertEnabled = () => {
    if (!passwordBinding) {
      const error = new Error('Passkeys require UI password protection to be enabled');
      error.statusCode = 400;
      throw error;
    }
  };

  const getPasskeysForRpId = (store, rpID) => store.passkeys.filter((passkey) => passkey.rpID === rpID);

  const getStatus = (req) => {
    const store = loadStore();
    const rpID = getCurrentRpId(req);
    return {
      enabled: Boolean(passwordBinding),
      hasPasskeys: Boolean(rpID) && getPasskeysForRpId(store, rpID).length > 0,
      passkeyCount: Boolean(rpID) ? getPasskeysForRpId(store, rpID).length : 0,
      rpID,
    };
  };

  const listPasskeys = (req) => {
    assertEnabled();

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    if (!rpID) {
      return [];
    }

    return getPasskeysForRpId(store, rpID).map((passkey) => ({
      id: passkey.id,
      label: passkey.label,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    }));
  };

  const revokePasskey = (req, passkeyId) => {
    assertEnabled();

    const normalizedPasskeyId = typeof passkeyId === 'string' ? passkeyId.trim() : '';
    if (!normalizedPasskeyId) {
      const error = new Error('Passkey ID is required');
      error.statusCode = 400;
      throw error;
    }

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    const existingPasskey = store.passkeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID);

    if (!existingPasskey) {
      const error = new Error('Passkey not found for this host');
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

  const beginRegistration = async (req, { label } = {}) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const rpID = getCurrentRpId(req);
    if (!rpID) {
      const error = new Error('Unable to resolve a valid passkey host for this request');
      error.statusCode = 400;
      throw error;
    }

    const currentOrigin = getCurrentRequestOrigin(req);
    if (!currentOrigin) {
      const error = new Error('Unable to resolve a valid passkey origin for this request');
      error.statusCode = 400;
      throw error;
    }

    const store = loadStore();
    const userID = decodeUserId(store.userID);
    if (!userID) {
      const error = new Error('Passkey storage is invalid. Please try again.');
      error.statusCode = 500;
      throw error;
    }

    const options = await generateRegistrationOptions({
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

  const finishRegistration = async (payload) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const store = loadStore();
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const response = payload?.response;

    const matchingRecord = requestId ? registrationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error = new Error('Passkey setup has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    registrationChallenges.delete(requestId);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: matchingRecord.challenge,
      expectedOrigin: matchingRecord.expectedOrigins,
      expectedRPID: matchingRecord.expectedRPIDs,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      const error = new Error('Passkey registration could not be verified');
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
      transports: Array.isArray(credential.transports) ? credential.transports.filter((value) => typeof value === 'string') : [],
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

  const beginAuthentication = async (req) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const store = loadStore();
    const rpID = getCurrentRpId(req);
    const passkeys = getPasskeysForRpId(store, rpID);

    if (!rpID || passkeys.length === 0) {
      const error = new Error('No passkeys are registered for this host yet');
      error.statusCode = 404;
      throw error;
    }

    const options = await generateAuthenticationOptions({
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

  const finishAuthentication = async (payload) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const response = payload?.response;
    const store = loadStore();
    const passkey = store.passkeys.find((item) => item.id === response?.id);

    if (!passkey) {
      const error = new Error('That passkey is not registered for this OpenChamber instance');
      error.statusCode = 404;
      throw error;
    }

    const matchingRecord = requestId ? authenticationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error = new Error('Passkey sign-in has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    authenticationChallenges.delete(requestId);

    const verification = await verifyAuthenticationResponse({
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
      const error = new Error('Passkey sign-in could not be verified');
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
    clearAllPasskeys,
    beginRegistration,
    finishRegistration,
    beginAuthentication,
    finishAuthentication,
    dispose,
    isLocalRpId,
  };
};
