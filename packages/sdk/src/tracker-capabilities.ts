import { z } from 'zod';

export type TrackerCapabilities = {
  multipleAccounts: boolean;
  stateUpdate: boolean;
  children: boolean;
  labels: boolean;
  priority: boolean;
  fields: boolean;
  filters: { people: boolean; priority: boolean };
  projectMapping: boolean;
  sessionComments: boolean;
};

export const trackerCapabilitiesSchema = z.object({
  multipleAccounts: z.boolean().default(false),
  stateUpdate: z.boolean().default(false),
  children: z.boolean().default(false),
  labels: z.boolean().default(false),
  priority: z.boolean().default(false),
  fields: z.boolean().default(false),
  filters: z.object({ people: z.boolean().default(false), priority: z.boolean().default(false) }).strict().default({ people: false, priority: false }),
  projectMapping: z.boolean().default(false),
  sessionComments: z.boolean().default(false),
}).strict() satisfies z.ZodType<TrackerCapabilities>;
