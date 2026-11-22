import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameSyncWithRetry } from '../../shared/atomic-rename.js';
import { readBoundedFileSync } from '../../shared/bounded-file-read.js';

const MANAGED_QUOTA_PROVIDERS = new Set(['exe-dev', 'cursor', 'zenmux', 'opendesign']);

const credentialsDirectory = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'quota',
);

const credentialPath = (providerId) => {
  if (!MANAGED_QUOTA_PROVIDERS.has(providerId)) throw new Error('Unsupported credential provider');
  return path.join(credentialsDirectory(), `${providerId}.json`);
};

// A credential file is one provider token object — a few hundred bytes of
// JSON. 64 KiB is generous headroom for that shape, and anything past it is
// not a credential: the bounded reader refuses it (and any non-regular
// file, e.g. a FIFO, promptly) instead of buffering it whole through a
// synchronous read that would block the whole server (#1613). A refusal
// answers exactly like an unreadable file always has here: warn + null.
const QUOTA_CREDENTIAL_MAX_BYTES = 64 * 1024;

export const readQuotaCredential = (providerId, normalize) => {
  try {
    const result = readBoundedFileSync(credentialPath(providerId), QUOTA_CREDENTIAL_MAX_BYTES);
    if (!result.ok) {
      if (result.reason === 'missing') return null;
      console.warn(`Failed to read ${providerId} quota credentials`);
      return null;
    }
    return normalize(JSON.parse(result.buffer.toString('utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`Failed to read ${providerId} quota credentials`);
    return null;
  }
};

export const writeQuotaCredential = (providerId, credential) => {
  const target = credentialPath(providerId);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  // Tighten only a directory this write created: an existing one keeps the
  // permissions and ACLs an administrator gave it.
  if (fs.mkdirSync(directory, { recursive: true, mode: 0o700 })) fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
};

export const deleteQuotaCredential = (providerId) => {
  try { fs.unlinkSync(credentialPath(providerId)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

// OpenCode Go used to store a browser auth cookie here. Its usage API now uses
// OpenCode's auth.json API key, so remove the obsolete secret without reading it.
export const deleteLegacyOpenCodeGoCredential = () => {
  try {
    fs.unlinkSync(path.join(credentialsDirectory(), 'opencode-go.json'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

// Ollama Cloud stored a browser session cookie here; it reads the API key now,
// so the cookie is obsolete. Removed without being read, and a failure only
// warns, since the file is ignored either way. The directory is the shape an
// unreleased development build wrote.
export const deleteLegacyOllamaCloudCredential = () => {
  const directory = credentialsDirectory();
  // A missing file is expected; anything else may leave the cookie on disk.
  const report = (error) => {
    if (error?.code !== 'ENOENT') {
      console.warn('Failed to remove obsolete Ollama Cloud credential:', error);
    }
  };
  try {
    fs.unlinkSync(path.join(directory, 'ollama-cloud.json'));
  } catch (error) {
    report(error);
  }
  try {
    fs.rmSync(path.join(directory, 'ollama-cloud'), { recursive: true, force: true });
  } catch (error) {
    report(error);
  }
};
