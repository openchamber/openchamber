import { z } from 'zod';

const navigationString = z.string().trim().min(1).max(4096);

export const vscodeSettingsNavigationSchema = z.object({
  page: navigationString,
  itemId: navigationString.nullish(),
  directory: navigationString.nullish(),
  connectProvider: z.boolean().optional(),
  providerId: navigationString.nullish(),
  skillName: navigationString.nullish(),
  snippetDraft: z.object({
    name: navigationString,
    scope: z.enum(['global', 'project']),
  }).optional(),
});

export type VSCodeSettingsNavigation = z.infer<typeof vscodeSettingsNavigationSchema>;
