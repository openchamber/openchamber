import { createHash, randomBytes } from 'node:crypto';

const normalizeIdentityPart = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\x00-\x1F\x7F]/.test(trimmed)
    ? trimmed
    : '';
};

export const createOwnerInstanceId = () => randomBytes(24).toString('base64url');

export const normalizeOwnerInstanceId = (value) => normalizeIdentityPart(value);

export const createRuntimeIdentity = ({ dataDir, platform = process.platform, runtime = 'web' } = {}) =>
  createHash('sha256')
    .update(JSON.stringify([platform, normalizeIdentityPart(runtime), normalizeIdentityPart(dataDir)]))
    .digest('base64url');

export const createLaunchFingerprint = ({ binary, args = [], hostname, port, cwd } = {}) =>
  createHash('sha256')
    .update(JSON.stringify([
      normalizeIdentityPart(binary),
      Array.isArray(args) ? args.map(normalizeIdentityPart) : [],
      normalizeIdentityPart(hostname),
      port,
      normalizeIdentityPart(cwd),
    ]))
    .digest('base64url');

export const normalizeOwnerIdentity = ({ ownerInstanceId, runtimeIdentity, launchFingerprint } = {}) => {
  const normalized = {
    ownerInstanceId: normalizeIdentityPart(ownerInstanceId),
    runtimeIdentity: normalizeIdentityPart(runtimeIdentity),
    launchFingerprint: normalizeIdentityPart(launchFingerprint),
  };
  if (Object.values(normalized).some((value) => value.length === 0)) return null;
  return normalized;
};
