import { deleteManagedCredential, getManagedCredentialStatus, normalizers, readManagedCredential, writeManagedCredential } from './credentials/providers.js';

export const normalizeOpenCodeGoCredential = normalizers['opencode-go'];

export const readOpenCodeGoCredential = () => readManagedCredential('opencode-go');

export const getOpenCodeGoCredentialStatus = () => getManagedCredentialStatus('opencode-go');

export const writeOpenCodeGoCredential = (value) => writeManagedCredential('opencode-go', value);

export const deleteOpenCodeGoCredential = () => deleteManagedCredential('opencode-go');
