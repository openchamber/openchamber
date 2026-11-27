import { normalizeGitRemoteEndpoint, parseGitCredentialReference } from '../git/credential-resolver.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import type { BindingDraft } from './binding-contract.js';

type AuxiliaryGrant = BindingDraft['auxiliary'][number];

const DERIVED_LFS_SUFFIX = '.git/info/lfs';

export const credentialServesEndpoint = (credentialId: string, rawEndpoint: string) => {
  try {
    return parseGitCredentialReference(credentialId).transport === normalizeGitRemoteEndpoint(rawEndpoint).protocol;
  } catch {
    return false;
  }
};

const exactGrant = (auxiliary: readonly AuxiliaryGrant[], kind: AuxiliaryGrant['kind'], endpoint: string) => auxiliary.find((entry) => entry.kind === kind
  && entry.endpoint.fingerprint === fingerprintRemoteUrl(endpoint) && entry.endpoint.displayUrl === redactRemoteUrl(endpoint));

const previousDerivedLfsEndpoint = (rawEndpoint: string, derivedFromRemote: string | undefined) => {
  if (!derivedFromRemote || !/^https:\/\//i.test(derivedFromRemote) || !rawEndpoint.endsWith(DERIVED_LFS_SUFFIX)) return undefined;
  const remote = redactRemoteUrl(derivedFromRemote);
  if (!remote || remote.endsWith('.git') || fingerprintRemoteUrl(`${remote}${DERIVED_LFS_SUFFIX}`) !== fingerprintRemoteUrl(rawEndpoint)) return undefined;
  return `${rawEndpoint.slice(0, -DERIVED_LFS_SUFFIX.length)}/info/lfs`;
};

export function carriedOverAuxiliaryGrant(auxiliary: readonly AuxiliaryGrant[], kind: AuxiliaryGrant['kind'], rawEndpoint: string, derivedFromRemote: string | undefined) {
  const previousEndpoint = kind === 'lfs' ? previousDerivedLfsEndpoint(rawEndpoint, derivedFromRemote) : undefined;
  return previousEndpoint ? exactGrant(auxiliary, kind, previousEndpoint) : undefined;
}

const carriedOver = (grant: AuxiliaryGrant, rawEndpoint: string) => grant.readiness === 'ready'
  && (grant.mode !== 'managed' || Boolean(grant.credentialId && credentialServesEndpoint(grant.credentialId, rawEndpoint)));

export function savedAuxiliaryGrant(auxiliary: readonly AuxiliaryGrant[], kind: AuxiliaryGrant['kind'], rawEndpoint: string, derivedFromRemote: string | undefined) {
  const exact = exactGrant(auxiliary, kind, rawEndpoint);
  if (exact) return exact;
  const previous = carriedOverAuxiliaryGrant(auxiliary, kind, rawEndpoint, derivedFromRemote);
  if (!previous) return undefined;
  return carriedOver(previous, rawEndpoint) ? previous : null;
}
