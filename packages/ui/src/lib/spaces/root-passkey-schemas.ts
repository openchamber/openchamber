import { z } from 'zod';

const credentialSchema = z.object({ id: z.string().min(1), label: z.string() });
export const rootApprovalChallengeSchema = z.object({
  challenge: z.string().min(1), rpID: z.string().min(1), allowCredentials: z.array(credentialSchema).min(1),
});
export const rootActivationChallengeSchema = rootApprovalChallengeSchema.extend({
  expiresAt: z.union([z.number(), z.string()]),
  allowCredentials: z.array(credentialSchema.extend({ origin: z.string().min(1) })).min(1),
});
export const rootApprovalResultSchema = z.object({
  awaitingConfirmation: z.literal(true), fingerprint: z.string().min(1), label: z.string(), origin: z.string(),
});
export const rootPasskeysSchema = z.object({
  available: z.boolean(), reason: z.string().nullable(),
  passkeys: z.array(z.object({
    id: z.string(), label: z.string(), origin: z.string(), rpID: z.string(),
    approvedAt: z.union([z.string(), z.number()]), fingerprint: z.string(),
  })),
});

export type RootPasskeyChallenge = z.infer<typeof rootApprovalChallengeSchema>;
export type RootActivationChallenge = z.infer<typeof rootActivationChallengeSchema>;
export type RootPasskeys = z.infer<typeof rootPasskeysSchema>;
export type RootApprovalResult = z.infer<typeof rootApprovalResultSchema>;
