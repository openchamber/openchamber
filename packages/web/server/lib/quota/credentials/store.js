import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED_QUOTA_PROVIDERS = new Set(['opencode-go', 'ollama-cloud', 'cursor']);

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
