import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';

export const gitIdentityProfileIdSchema = z.string().trim().min(1).max(200);
const profileTextSchema = z.string().trim().min(1).max(512);
const optionalProfileTextSchema = z.string().trim().max(512).nullable().optional();

const gitIdentityAccountSchema = z.object({
  provider: sourceControlProviderIdSchema,
  instance: profileTextSchema,
  accountId: profileTextSchema,
}).strict();

const gitIdentityTransportSchema = z.enum(['account', 'ssh', 'system', 'anonymous']);

export type GitIdentityTransport = z.infer<typeof gitIdentityTransportSchema>;

export const gitIdentityProfileSchema = z.object({
  id: gitIdentityProfileIdSchema,
  name: profileTextSchema,
  userName: profileTextSchema,
  userEmail: profileTextSchema,
  account: gitIdentityAccountSchema.nullable().optional(),
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
  profile: gitIdentityProfileSchema.nullable(),
}).strict();

export const isCompleteIdentity = (
  profile: Pick<GitIdentityProfile, 'account' | 'transport' | 'sshCredentialId' | 'userName' | 'userEmail'>,
): boolean => Boolean(profile.userName) && Boolean(profile.userEmail)
  && ((profile.transport === 'account' && Boolean(profile.account))
    || profile.transport === 'anonymous'
    || profile.transport === 'system' || profile.transport === undefined
    || (profile.transport === 'ssh' && Boolean(profile.sshCredentialId)));
