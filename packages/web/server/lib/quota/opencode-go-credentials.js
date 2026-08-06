import { deleteManagedCredential, getManagedCredentialStatus, readManagedCredential, writeManagedCredential } from './credentials/providers.js';

export const readOpenCodeGoCredential = () => readManagedCredential('opencode-go');

export const getOpenCodeGoCredentialStatus = () => getManagedCredentialStatus('opencode-go');

export const writeOpenCodeGoCredential = (value) => writeManagedCredential('opencode-go', value);

export const deleteOpenCodeGoCredential = () => deleteManagedCredential('opencode-go');
