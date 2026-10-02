import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED_QUOTA_PROVIDERS = new Set(['exe-dev', 'cursor']);

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

export const readQuotaCredential = (providerId, normalize) => {
  try {
    return normalize(JSON.parse(fs.readFileSync(credentialPath(providerId), 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`Failed to read ${providerId} quota credentials`);
    return null;
  }
};

export const writeQuotaCredential = (providerId, credential) => {
  const target = credentialPath(providerId);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
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

// Ollama Cloud stored a browser session cookie here. Its usage now comes from
// `GET /api/usage` with the API key OpenCode already holds, so the cookie is
// obsolete. Removed without being read; a failure is not fatal, since the
// cookie is simply ignored from now on. The directory is the shape an unreleased
// development build wrote, cleaned up for anyone who ran it.
export const deleteLegacyOllamaCloudCredential = () => {
  const directory = credentialsDirectory();
  // A missing file is the expected state and says nothing. Anything else may
  // mean the cookie is still on disk, and a message without the reason is not
  // diagnosable.
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
