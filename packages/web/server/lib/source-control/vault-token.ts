// Source-control accounts added from a vault keep only the reference to their
// token (op://…) and read it when the token is used. A fork module.
import { isVaultReference } from '../environment/vault.js';

// Reads a vault reference's secret (`readSecret` of ../environment/vault.js),
// set once by the server. Without it an account added from a vault has no token.
type VaultSecretReader = (reference: string) => Promise<{ ok: true; value: string } | { ok: false; reason: string }>;
let readVaultSecret: VaultSecretReader | null = null;

/** The server's vault reader, for accounts that keep a token reference. */
export const configureSourceControlVaultReader = (reader: VaultSecretReader | null) => {
  readVaultSecret = reader;
};

/** A vault reference's token, for checking it before an account keeps the reference. */
export const readSourceControlVaultToken = (reference: string) => (readVaultSecret
  ? readVaultSecret(reference)
  : Promise.resolve({ ok: false as const, reason: 'vault-unavailable' }));

/**
 * The credential with the token filled in from its vault reference. A token
 * that cannot be read leaves the token empty and names why in `tokenReadError`;
 * the stored credential is unchanged.
 */
export const withVaultToken = async <Credential extends { tokenReference?: string | undefined; token?: string } | null | undefined>(credential: Credential): Promise<Credential> => {
  if (!credential?.tokenReference) return credential;
  const outcome = await readSourceControlVaultToken(credential.tokenReference);
  return outcome.ok ? { ...credential, token: outcome.value } : { ...credential, token: '', tokenReadError: outcome.reason };
};

/** A stored vault account: a PAT that keeps a well-formed reference and no token. */
export const isStoredVaultAccount = (value: { [key: string]: unknown }, validText: (text: unknown) => text is string) => (
  !Object.hasOwn(value, 'token') && value.source === 'pat' && validText(value.tokenReference) && isVaultReference(value.tokenReference)
);
