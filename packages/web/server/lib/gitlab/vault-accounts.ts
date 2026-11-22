// GitLab accounts whose token stays in a vault (op://…). A fork module.
import { isVaultReference } from '../environment/vault.js';
import { readSourceControlVaultToken } from '../source-control/vault-token.js';
import type { GitLabUser } from './user.js';

type VaultCredential = { tokenReference?: string | undefined; tokenReadError?: string | undefined };

/** What an account status adds for a vault account: why its token could not be read. */
export type VaultAccountStatusFields = { tokenReadError?: string };

/** A GitLab request refused the token (`GitLabRequestError` kind, network.ts). */
export const isInvalidTokenFailure = (error: unknown): error is Error & { kind: 'invalid-token' } => error instanceof Error && 'kind' in error && error.kind === 'invalid-token';

const vaultError = (status: number, body: { error: string; code: string; reason?: string }) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

/** An account view that also says where a vault account's token is kept; never the token. */
export const withTokenReference = <View extends object>(view: View, account: VaultCredential) => (
  account.tokenReference ? { ...view, tokenReference: account.tokenReference } : view
);

/**
 * Why a vault account is not connected, or null for any other account. A vault
 * account is never marked invalid: an unreadable or refused token is most
 * likely rotated or mistyped in the vault, and the next read picks the fix up.
 */
export const vaultAccountProblem = (active: VaultCredential, refused = false) => {
  if (!active.tokenReference) return null;
  if (active.tokenReadError) {
    return { tokenReadError: active.tokenReadError, message: `The token at ${active.tokenReference} could not be read (${active.tokenReadError})` };
  }
  return refused ? { message: `GitLab refused the token at ${active.tokenReference}; update it there` } : null;
};

/**
 * Reads `reference` and checks its token with the instance before an account
 * keeps only the reference.
 */
export const verifyVaultToken = async (
  reference: string,
  verify: (token: string) => Promise<GitLabUser>,
  isInvalidToken: (error: Error) => boolean,
) => {
  const tokenReference = reference.trim();
  if (!isVaultReference(tokenReference)) {
    throw vaultError(400, { error: 'reference must be a 1Password reference such as op://Vault/item/field', code: 'INVALID_REFERENCE' });
  }
  const read = await readSourceControlVaultToken(tokenReference);
  if (!read.ok) throw vaultError(400, { error: `The token could not be read from 1Password (${read.reason})`, code: 'VAULT_READ_FAILED', reason: read.reason });
  try {
    return { tokenReference, user: await verify(read.value) };
  } catch (error) {
    if (error instanceof Error && isInvalidToken(error)) throw vaultError(401, { error: 'GitLab refused the token from 1Password', code: 'INVALID_TOKEN' });
    throw error;
  }
};

/** The provider's `addFromVault`: adds an account that keeps only its token's vault reference. */
export const createAddFromVault = <Credential>({ verify, setAccount, announce, isInvalidToken }: {
  verify: (origin: string, token: string) => Promise<GitLabUser>;
  setAccount: (origin: string, input: { tokenReference: string; user: GitLabUser; source: 'pat' }) => Promise<Credential>;
  announce: (origin: string, credential: Credential, user: GitLabUser) => Promise<void>;
  isInvalidToken: (error: Error) => boolean;
}) => async ({ instance: origin, reference }: { instance: string; reference: string }) => {
  const { tokenReference, user } = await verifyVaultToken(reference, (token) => verify(origin, token), isInvalidToken);
  await announce(origin, await setAccount(origin, { tokenReference, user, source: 'pat' }), user);
  return { connected: true, user };
};
