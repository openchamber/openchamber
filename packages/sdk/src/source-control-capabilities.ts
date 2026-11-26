import { z } from 'zod';

export type SourceControlMergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';

export const sourceControlCapabilitiesSchema = z.object({
  projects: z.boolean().default(false),
  issues: z.boolean().default(false),
  changeRequests: z.boolean().default(false),
  draftChangeRequests: z.boolean().default(false),
  draftConversion: z.boolean().optional(),
  merge: z.union([
    z.literal(false),
    z.object({
      methods: z.array(z.enum(['merge', 'squash', 'rebase', 'submit'])).min(1).max(3)
        .refine((methods) => new Set(methods).size === methods.length, { message: 'merge methods must be unique' })
        .refine((methods) => !methods.includes('submit') || methods.length === 1, { message: '"submit" is the only merge method when present' }),
    }).strict(),
  ]).default(false),
  ci: z.boolean().default(false),
  comments: z.boolean().default(false),
  commentEdit: z.boolean().default(false),
  reviews: z.boolean().default(false),
  state: z.boolean().default(false),
  labels: z.boolean().default(false),
  reviewers: z.boolean().default(false),
  reviewThreads: z.object({
    reply: z.boolean().default(false).catch(false),
    resolve: z.boolean().default(false).catch(false),
  }).strict().default({ reply: false, resolve: false }),
  reviewDrafts: z.object({
    fileComments: z.boolean().default(false).catch(false),
  }).strict().optional(),
  reviewDismiss: z.union([z.literal('others'), z.literal('own')]).optional().catch(undefined),
  reviewUndismiss: z.boolean().optional().catch(undefined),
  changeRequestPatch: z.boolean().default(false),
  liveSummaries: z.boolean().default(false),
  reviewModel: z.enum(['verdict', 'votes']).optional(),
  revisions: z.boolean().optional(),
}).strict();

export type SourceControlCapabilities = {
  projects: boolean;
  issues: boolean;
  changeRequests: boolean;
  draftChangeRequests: boolean;
  draftConversion?: boolean;
  merge: false | { methods: SourceControlMergeMethod[] };
  ci: boolean;
  comments: boolean;
  commentEdit: boolean;
  reviews: boolean;
  state: boolean;
  labels: boolean;
  reviewers: boolean;
  reviewThreads?: { reply?: boolean; resolve?: boolean };
  reviewDrafts?: { fileComments: boolean };
  reviewDismiss?: 'others' | 'own';
  reviewUndismiss?: boolean;
  changeRequestPatch: boolean;
  liveSummaries: boolean;
  reviewModel?: 'verdict' | 'votes';
  revisions?: boolean;
};
