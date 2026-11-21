import { z } from 'zod';
import { isGuestRequestPath } from './contract.ts';
import { SOURCE_CONTROL_URL_TEMPLATES_MAX } from './manifest.ts';

const urlTemplatesSchema = z.array(z.string().trim().min(1)).max(SOURCE_CONTROL_URL_TEMPLATES_MAX);

export const sourceControlUrlsSchema = z.object({
  changeRequest: urlTemplatesSchema,
  issue: urlTemplatesSchema,
  resolve: z.string().max(256).refine(isGuestRequestPath).optional(),
}).strict();
