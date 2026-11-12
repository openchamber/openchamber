import { z } from 'zod';
import { directory, id, sessionId, text, time } from './stream-fields.js';

// An agent server cannot own Spaces approval workers. A claimed worker or
// approval receipt is refused before any UI can offer a host operation for it.
export const agentFixLoopSchema = z.object({
    id, sessionId, directory, owner: id, repo: id, number: z.number().int().positive(), url: text, title: text, branch: text,
    status: z.enum(['watching', 'working', 'waitingForPush', 'ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']),
    statusReason: text.nullable(),
    config: z.object({
      watch: z.boolean().optional(), maxIterations: z.number().int().min(1).max(50), tokenBudget: time.nullable(),
      triggers: z.enum(['both', 'ci', 'review']), ignoreSelf: z.boolean(), ignoreBots: z.boolean(),
      allowAuthors: z.array(text), blockAuthors: z.array(text), mentionOnly: z.boolean(), mentionText: text, pushMode: z.literal('auto'),
    }),
    iterations: time, totalIterations: time.optional(), tokensUsed: time,
    ci: z.object({ state: z.enum(['success', 'failure', 'pending', 'unknown']), headSha: text }).nullable(),
    unresolvedThreads: time.nullable(), changesRequested: z.boolean().nullable(),
    worker: z.null().optional(), pendingApproval: z.null().optional(),
    review: z.null().optional(),
    lastCheckedAt: time.nullable(), lastError: text.nullable(), createdAt: time, updatedAt: time,
});
export const fixLoopEventSchema = z.union([
  z.object({ id, removed: z.literal(true) }),
  z.object({ loop: agentFixLoopSchema }),
]);
