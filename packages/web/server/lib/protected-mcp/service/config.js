import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';

const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
const absolute = (value, field) => {
  if (!isString(value) || !path.isAbsolute(value) || path.normalize(value) !== value) throw new ProtectedMcpError('invalid_config', { message: `invalid_config: ${field}` });
  return value;
};

/** The installed service configuration. Keys it does not read are ignored. */
export function parseServiceConfig(value) {
  if (!isPlainObject(value) || value.version !== 1) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: version' });
  if (!isString(value.engineUser) || !ACCOUNT.test(value.engineUser)) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: engineUser' });
  const adminSocketGroup = value.adminSocketGroup ?? null;
  if (adminSocketGroup !== null && !Number.isSafeInteger(adminSocketGroup)) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: adminSocketGroup' });
  const npm = value.npm ?? null;
  if (npm !== null && (!Array.isArray(npm) || npm.length === 0)) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: npm' });
  const workerPath = value.workerPath ?? '/usr/local/bin:/usr/bin:/bin';
  if (!isString(workerPath) || !workerPath.split(':').every((entry) => path.isAbsolute(entry))) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: workerPath' });
  return {
    serviceVersion: isString(value.serviceVersion) ? value.serviceVersion : 'unknown',
    stateDir: absolute(value.stateDir, 'stateDir'),
    engineSocket: absolute(value.engineSocket, 'engineSocket'),
    subjectsDir: absolute(value.subjectsDir ?? '/run/openchamber-protected-mcp/subjects', 'subjectsDir'),
    engineSocketGroup: Number.isSafeInteger(value.engineSocketGroup) ? value.engineSocketGroup : null,
    adminSocket: absolute(value.adminSocket ?? '/run/openchamber-protected-mcp-admin/admin.sock', 'adminSocket'),
    adminSocketGroup,
    engineUser: value.engineUser,
    engineUnit: isString(value.engineUnit) ? value.engineUnit : null,
    workerPath,
    node: absolute(value.node, 'node'),
    npm: npm === null ? null : npm.map((part, index) => absolute(part, `npm.${index}`)),
    installDir: absolute(value.installDir, 'installDir'),
    configDir: absolute(value.configDir, 'configDir'),
  };
}
