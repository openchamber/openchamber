import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialJson, ManagedCredential } from './contracts.js';

const MANAGED_QUOTA_PROVIDERS = new Set(['exe-dev', 'cursor', 'zenmux']);

const credentialsDirectory = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'quota',
);

const credentialPath = (providerId: string) => {
  if (!MANAGED_QUOTA_PROVIDERS.has(providerId)) throw new Error('Unsupported credential provider');
  return path.join(credentialsDirectory(), `${providerId}.json`);
};

const isMissingFile = (value: unknown): value is { code: 'ENOENT' } => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && 'code' in value && value.code === 'ENOENT';

export const readQuotaCredential = <T>(providerId: string, normalize: (value: CredentialJson) => T) => {
  try {
    const value: CredentialJson = JSON.parse(fs.readFileSync(credentialPath(providerId), 'utf8'));
    return normalize(value);
  } catch (error) {
    if (!isMissingFile(error)) console.warn(`Failed to read ${providerId} quota credentials`);
    return null;
  }
};

const removeTemporaryFile = (temporary: string) => {
  try {
    fs.unlinkSync(temporary);
  } catch {
    return;
  }
};

export const writeQuotaCredential = (providerId: string, credential: ManagedCredential) => {
  const target = credentialPath(providerId);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  if (fs.mkdirSync(directory, { recursive: true, mode: 0o700 })) fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    removeTemporaryFile(temporary);
  }
};

export const deleteQuotaCredential = (providerId: string) => {
  try { fs.unlinkSync(credentialPath(providerId)); } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
};

export const deleteLegacyOpenCodeGoCredential = () => {
  try {
    fs.unlinkSync(path.join(credentialsDirectory(), 'opencode-go.json'));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
};

export const deleteLegacyOllamaCloudCredential = () => {
  const directory = credentialsDirectory();
  const report = (cause: unknown) => {
    if (!isMissingFile(cause)) {
      console.warn('Failed to remove obsolete Ollama Cloud credential:', cause);
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
