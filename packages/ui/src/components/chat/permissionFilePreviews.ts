import { z } from 'zod';

// OpenCode FileDiff.Info metadata used by the plugin edit/write tools.
const filePreviewSchema = z.object({
  file: z.string(),
  patch: z.string().min(1),
});

export const permissionFilePreviewsSchema = z.array(filePreviewSchema.nullable().catch(null))
  .catch([])
  .transform((files) => files.filter((file) => file !== null));
