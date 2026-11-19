import { isPlainObject, isString } from '../shared/guards.js';

export const isGitString = (value: unknown): value is string => isString(value);

export const isGitObject = (value: unknown): value is object => isPlainObject(value);

export const isGitArray = (value: unknown): value is unknown[] => Array.isArray(value);

interface GitCredentialErrorFields {
  code?: unknown;
  managedSshRecordCommitted?: unknown;
}

const hasCredentialErrorFields = (value: unknown): value is GitCredentialErrorFields => value !== null && value !== undefined;

export const gitCredentialErrorFields = <Value>(value: Value) => hasCredentialErrorFields(value) ? value : undefined;

export const hasGitCredentialErrorCode = <Value>(value: Value, codes: readonly string[]) => {
  const code = gitCredentialErrorFields(value)?.code;
  return codes.some((candidate) => candidate === code);
};

export const credentialDependency = <Value>(value: Value | null | undefined, member: string): Value => {
  if (value === undefined || value === null) {
    throw new TypeError(`Cannot read properties of ${String(value)} (reading '${member}')`);
  }
  return value;
};
