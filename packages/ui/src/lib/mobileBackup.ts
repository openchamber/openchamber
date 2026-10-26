/**
 * Password-encrypted backup file for what the phone app keeps on the device.
 *
 * The file is JSON so a person can park it in a password manager or a cloud
 * drive: a small header (format, version, KDF and cipher parameters) followed by
 * the base64 ciphertext. Everything that identifies a server — labels,
 * transports and access tokens — lives inside `data`; the password never does.
 *
 * PBKDF2-HMAC-SHA256 stretches the password and AES-GCM-256 encrypts and
 * authenticates the payload in one pass, so a truncated or edited file fails to
 * open instead of restoring half of its contents. The format string and version
 * are authenticated as additional data, so neither can be relabelled.
 *
 * An envelope is untrusted input. `parseMobileBackupFile` runs before any key
 * derivation: the iteration count stays inside a fixed window, so a crafted
 * file cannot ask the phone for an hour of work, and every base64 field must
 * decode to the length its algorithm needs.
 */

export const MOBILE_BACKUP_FORMAT = 'openchamber.mobile.backup';
export const MOBILE_BACKUP_VERSION = 1;

/** PBKDF2 rounds written by this build. */
export const MOBILE_BACKUP_ITERATIONS = 210_000;
/** Import window: enough to open any file this build writes, small enough to bound the work. */
export const MOBILE_BACKUP_MIN_ITERATIONS = 10_000;
export const MOBILE_BACKUP_MAX_ITERATIONS = 5_000_000;
/** A payload of twelve saved servers is a few kilobytes; a megabyte is already generous. */
export const MOBILE_BACKUP_MAX_BYTES = 1_000_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

export type MobileBackupErrorCode =
  | 'invalid-file'
  | 'invalid-payload'
  | 'invalid-password'
  | 'unsupported-version'
  | 'wrong-password'
  | 'crypto-unavailable';

export class MobileBackupError extends Error {
  readonly code: MobileBackupErrorCode;

  constructor(code: MobileBackupErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MobileBackupError';
    this.code = code;
  }
}

export interface MobileBackupFile {
  format: typeof MOBILE_BACKUP_FORMAT;
  version: number;
  createdAt: string;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    /** base64, `SALT_BYTES` long. */
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    /** base64, `IV_BYTES` long. */
    iv: string;
  };
  /** base64 ciphertext of the JSON payload. */
  data: string;
}

// Web Crypto's BufferSource wants a view over a plain ArrayBuffer, and the
// default `Uint8Array` type admits a SharedArrayBuffer; these helpers keep the
// narrower type along the encryption path.
type Bytes = Uint8Array<ArrayBuffer>;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  // Chunked so a large payload never overflows the argument limit of fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Bytes => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeBase64 = (value: unknown, expectedBytes?: number): Bytes | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  let bytes: Bytes;
  try {
    bytes = base64ToBytes(value);
  } catch {
    return null;
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) return null;
  return bytes;
};

const encodeUtf8 = (value: string): Bytes => new TextEncoder().encode(value);

const webCrypto = (): Crypto => {
  const available = globalThis.crypto;
  // An insecure origin (plain http) is the usual cause on a phone.
  if (!available?.subtle || typeof available.getRandomValues !== 'function') {
    throw new MobileBackupError('crypto-unavailable');
  }
  return available;
};

const subtle = (): SubtleCrypto => webCrypto().subtle;

const randomBytes = (length: number): Bytes => {
  const bytes = new Uint8Array(length);
  webCrypto().getRandomValues(bytes);
  return bytes;
};

/** Binds the ciphertext to the file's identity: a relabelled version fails to decrypt. */
const additionalData = (): Bytes => encodeUtf8(`${MOBILE_BACKUP_FORMAT}:${MOBILE_BACKUP_VERSION}`);

const deriveKey = async (password: string, salt: Bytes, iterations: number): Promise<CryptoKey> => {
  const crypto = subtle();
  const material = await crypto.importKey('raw', encodeUtf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Read an envelope as unknown input. Throws `invalid-file` for anything that is
 * not a backup of this format, `unsupported-version` for a newer one.
 */
export const parseMobileBackupFile = (value: unknown): MobileBackupFile => {
  let document: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MOBILE_BACKUP_MAX_BYTES) throw new MobileBackupError('invalid-file');
    try {
      document = JSON.parse(value) as unknown;
    } catch {
      throw new MobileBackupError('invalid-file');
    }
  }

  if (!isRecord(document)) throw new MobileBackupError('invalid-file');
  if (document.format !== MOBILE_BACKUP_FORMAT) throw new MobileBackupError('invalid-file');

  const version = document.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MobileBackupError('invalid-file');
  }
  if (version !== MOBILE_BACKUP_VERSION) throw new MobileBackupError('unsupported-version');

  const kdf = document.kdf;
  if (!isRecord(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new MobileBackupError('invalid-file');
  }
  const iterations = kdf.iterations;
  if (
    typeof iterations !== 'number'
    || !Number.isInteger(iterations)
    || iterations < MOBILE_BACKUP_MIN_ITERATIONS
    || iterations > MOBILE_BACKUP_MAX_ITERATIONS
  ) {
    throw new MobileBackupError('invalid-file');
  }
  const salt = decodeBase64(kdf.salt, SALT_BYTES);
  if (!salt) throw new MobileBackupError('invalid-file');

  const cipher = document.cipher;
  if (!isRecord(cipher) || cipher.name !== 'AES-GCM') throw new MobileBackupError('invalid-file');
  const iv = decodeBase64(cipher.iv, IV_BYTES);
  if (!iv) throw new MobileBackupError('invalid-file');

  const data = typeof document.data === 'string' ? document.data : '';
  if (!data.trim() || !decodeBase64(data)) throw new MobileBackupError('invalid-file');

  return {
    format: MOBILE_BACKUP_FORMAT,
    version,
    createdAt: typeof document.createdAt === 'string' ? document.createdAt : '',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: kdf.salt as string },
    cipher: { name: 'AES-GCM', iv: cipher.iv as string },
    data,
  };
};

export interface EncryptMobileBackupOptions {
  /** Override the KDF rounds (tests). Kept inside the import window. */
  iterations?: number;
}

/**
 * Encrypt a JSON-serializable payload into a backup envelope. The caller owns
 * the payload shape; it is serialized here and parsed back at import.
 */
export const encryptMobileBackup = async (
  payload: unknown,
  password: string,
  options: EncryptMobileBackupOptions = {},
): Promise<MobileBackupFile> => {
  if (!password) throw new MobileBackupError('invalid-password');
  const iterations = options.iterations ?? MOBILE_BACKUP_ITERATIONS;
  if (iterations < MOBILE_BACKUP_MIN_ITERATIONS || iterations > MOBILE_BACKUP_MAX_ITERATIONS) {
    throw new MobileBackupError('invalid-password');
  }

  const crypto = subtle();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, iterations);
  const plaintext = encodeUtf8(JSON.stringify(payload));
  const ciphertext = await crypto.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData() },
    key,
    plaintext,
  );

  return {
    format: MOBILE_BACKUP_FORMAT,
    version: MOBILE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

/** Pretty JSON so the file stays readable when opened in an editor. */
export const serializeMobileBackup = (file: MobileBackupFile): string => JSON.stringify(file, null, 2);

/**
 * Open a backup file and return its payload as untrusted JSON. Only the
 * caller's payload parser can promote it to a trusted type.
 */
export const decryptMobileBackup = async (file: unknown, password: string): Promise<unknown> => {
  if (!password) throw new MobileBackupError('invalid-password');
  const envelope = parseMobileBackupFile(file);

  // Both were validated by the parser, so these decodes cannot fail.
  const salt = decodeBase64(envelope.kdf.salt)!;
  const iv = decodeBase64(envelope.cipher.iv)!;
  const ciphertext = decodeBase64(envelope.data)!;

  const crypto = subtle();
  const key = await deriveKey(password, salt, envelope.kdf.iterations);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData() },
      key,
      ciphertext,
    );
  } catch {
    // GCM authenticates, so a wrong password and a damaged payload are the same
    // failure here; "wrong password" is the one a person can act on.
    throw new MobileBackupError('wrong-password');
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    throw new MobileBackupError('invalid-payload');
  }
};
