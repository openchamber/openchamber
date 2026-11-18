import { z } from 'zod';

export const suggestionLevels = ['low', 'medium', 'high'] as const;
export const suggestionSeverities = ['low', 'medium', 'high', 'critical'] as const;
export const suggestionFileSchema = z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() });
export const botConversionSchema = z.object({
  kind: z.literal('bot'), botId: z.string().min(1), itemId: z.string().min(1), auto: z.boolean().optional(),
});
const conversionSchema = z.union([z.object({
  kind: z.enum(['session', 'worktree', 'draft-pr', 'todo', 'issue', 'draft']),
  auto: z.boolean().optional(), sessionId: z.string().optional(), directory: z.string().optional(),
  todoId: z.string().optional(), url: z.string().optional(),
}), botConversionSchema]);

/** Persisted suggestions and approval envelopes share this boundary parser. */
export const suggestionSchema = z.object({
  id: z.string(), runId: z.string(), lensId: z.string(), lensName: z.string(),
  title: z.string(), body: z.string(), files: z.array(suggestionFileSchema),
  evidence: z.array(z.object({
    source: z.string(), summary: z.string(),
    url: z.url({ protocol: /^https?$/ }).optional().catch(undefined),
  })).max(10).optional(),
  confidence: z.enum(suggestionLevels), severity: z.enum(suggestionSeverities), createdAt: z.number(),
  status: z.enum(['open', 'snoozed', 'dismissed', 'approved']), snoozedUntil: z.number().optional(),
  dismissedAt: z.number().optional(), dismissReason: z.string().optional(), approvedAt: z.number().optional(),
  conversion: conversionSchema.optional(), conversionPending: z.boolean().optional(),
  conversionRecoverable: z.boolean().optional(), conversionError: z.string().optional(),
});
