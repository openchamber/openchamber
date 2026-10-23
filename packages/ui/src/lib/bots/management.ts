import { z } from 'zod';

const text = z.string().min(1);
export const botIdentitySchema = z.object({
  id: text, revision: z.number().int().nonnegative(), label: text,
  kind: z.enum(['github-account', 'github-app', 'jira-account', 'jira-service', 'discord-app']),
  configured: z.boolean(), accountId: text.optional(), credentialRevision: z.number().optional(),
  appId: text.optional(), installationId: text.optional(), site: text.optional(), email: text.optional(), applicationId: text.optional(),
});
export type BotIdentity = z.infer<typeof botIdentitySchema>;
export type BotIdentityInput =
  | { readonly kind: 'github-account'; readonly label: string; readonly accountId: string; readonly credentialRevision: number }
  | { readonly kind: 'github-app'; readonly label: string; readonly appId: string; readonly installationId: string; readonly privateKey: string }
  | { readonly kind: 'jira-account' | 'jira-service'; readonly label: string; readonly site: string; readonly email: string; readonly apiToken: string }
  | { readonly kind: 'discord-app'; readonly label: string; readonly applicationId: string; readonly botToken: string };

const person = z.object({ id: text, name: text, roles: z.array(text), github: text.optional(), jira: text.optional(), discord: text.optional() });
export const botPolicySchema = z.object({
  fingerprint: text,
  areas: z.array(z.object({
    file: text, fingerprint: text, status: z.enum(['approved', 'changed', 'unapproved']),
    name: text, paths: z.array(text), level: z.enum(['human', 'judgment']), owners: z.array(text), body: z.string(),
  })),
  people: z.object({
    file: text, status: z.enum(['missing', 'invalid', 'approved', 'changed', 'unapproved']),
    fingerprint: text.optional(), people: z.array(person), error: z.string().optional(),
    content: z.string().optional(),
  }),
  issues: z.array(z.object({ file: text, error: text })),
});
