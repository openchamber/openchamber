import { isBoolean, isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError, isConnectionId } from './contract.js';
import { parseDefinition } from './definitions.js';

const MAX_SECRET_LENGTH = 64 * 1024;
const parseSecrets = (value) => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ProtectedMcpError('invalid_request', { message: 'secrets' });
  const secrets = {};
  for (const [slot, secret] of Object.entries(value)) {
    if (!isString(secret) || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
      throw new ProtectedMcpError('invalid_secret', { message: `invalid_secret: ${slot}` });
    }
    secrets[slot] = secret;
  }
  return secrets;
};

/** Parse the administrative operation before it enters the store's mutation queue. */
export function parseOperation(value) {
  if (!isPlainObject(value) || !isString(value.kind)) throw new ProtectedMcpError('invalid_request', { message: 'operation' });
  const existing = () => {
    if (!isConnectionId(value.id) || !Number.isSafeInteger(value.expectedRevision)) {
      throw new ProtectedMcpError('invalid_request', { message: 'id and expectedRevision' });
    }
    return { id: value.id, expectedRevision: value.expectedRevision };
  };
  switch (value.kind) {
    case 'create':
      return { kind: 'create', definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'update':
      return { kind: 'update', ...existing(), definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'set-enabled':
      if (!isBoolean(value.enabled)) throw new ProtectedMcpError('invalid_request', { message: 'enabled' });
      return { kind: 'set-enabled', ...existing(), enabled: value.enabled };
    case 'remove':
    case 'revoke-credentials':
      return { kind: value.kind, ...existing() };
    default:
      throw new ProtectedMcpError('invalid_request', { message: 'kind' });
  }
}
