import { z } from 'zod';

export const gitIdentityProfileIdSchema = z.string().trim().min(1).max(200);
const profileTextSchema = z.string().trim().min(1).max(512);
const optionalProfileTextSchema = z.string().trim().max(512).nullable().optional();

/** The provider account an identity acts as, addressed exactly as bindings address it. */
const gitIdentityAccountSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  instance: profileTextSchema,
  accountId: profileTextSchema,
}).strict();

/**
 * How an identity's transfers authenticate.
 *
 * `account` is the connected account's own credential over HTTPS — whether that
 * credential came from OAuth or from a personal access token is a property of
 * the account, not a separate choice. `ssh` names a managed key, and can still
 * carry an account so issues and change requests know whose they are.
 */
const gitIdentityTransportSchema = z.enum(['account', 'ssh', 'system', 'anonymous']);

export type GitIdentityTransport = z.infer<typeof gitIdentityTransportSchema>;

/**
 * One identity is an account, a transport and a signature.
 *
 * Repositories choose one of these instead of assembling the three separately,
 * so the same answer is given once and shown by name.
 */
export const gitIdentityProfileSchema = z.object({
  id: gitIdentityProfileIdSchema,
  name: profileTextSchema,
  userName: profileTextSchema,
  userEmail: profileTextSchema,
  account: gitIdentityAccountSchema.nullable().optional(),
  // Absent means an identity written before identities carried a transport:
  // it says who commits and nothing about how transfers authenticate. Read it
  // through `identityTransport` so that reading is stated in one place.
  transport: gitIdentityTransportSchema.optional(),
  sshCredentialId: optionalProfileTextSchema,
  signCommits: z.boolean().optional(),
  signingKey: optionalProfileTextSchema,
  color: optionalProfileTextSchema,
  icon: optionalProfileTextSchema,
}).strict().superRefine((profile, context) => {
  if (profile.transport === 'account' && !profile.account) {
    context.addIssue({ code: 'custom', path: ['account'], message: 'An account transport requires an account' });
  }
  if (profile.transport === 'ssh' && !profile.sshCredentialId?.trim()) {
    context.addIssue({ code: 'custom', path: ['sshCredentialId'], message: 'An SSH transport requires a managed key' });
  }
  if (profile.transport !== 'ssh' && profile.sshCredentialId) {
    context.addIssue({ code: 'custom', path: ['sshCredentialId'], message: 'Only an SSH transport names a managed key' });
  }
});

export type GitIdentityProfile = z.infer<typeof gitIdentityProfileSchema>;

/**
 * How an identity authenticates, for identities written before they said so.
 *
 * Signature-only identities name no credential, which is exactly what System
 * Git means, so that is what they resolve to.
 */
export const identityTransport = (
  profile: Pick<GitIdentityProfile, 'transport'> | null | undefined,
): GitIdentityTransport => profile?.transport ?? 'system';

export const gitIdentityProfilesSchema = z.array(gitIdentityProfileSchema).max(256)
  .refine((profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length, 'Git identity profile IDs must be unique');

export const gitIdentitySummarySchema = z.object({
  userName: z.string().max(512).nullable(),
  userEmail: z.string().max(512).nullable(),
}).strict();

export type GitIdentitySummary = z.infer<typeof gitIdentitySummarySchema>;

export const gitIdentityMutationResultSchema = z.object({
  success: z.boolean(),
  // Null when the repository now names no author of its own: the System
  // identity on a machine that has none either.
  profile: gitIdentityProfileSchema.nullable(),
}).strict();

/**
 * Whether an identity is complete: an account, a way to authenticate with it,
 * and a signature. Records written before identities carried an account are
 * still stored and shown in Git Settings, but no repository can choose them.
 */
export const isCompleteIdentity = (
  profile: Pick<GitIdentityProfile, 'account' | 'transport' | 'sshCredentialId' | 'userName' | 'userEmail'>,
): boolean => Boolean(profile.account) && Boolean(profile.userName) && Boolean(profile.userEmail)
  && (profile.transport === 'account' || profile.transport === 'anonymous'
    || (profile.transport === 'ssh' && Boolean(profile.sshCredentialId)));
