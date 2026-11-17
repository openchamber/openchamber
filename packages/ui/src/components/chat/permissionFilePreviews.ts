import { z } from 'zod';

const filePreviewSchema = z.object({
  file: z.string(),
  patch: z.string().min(1),
});

export const permissionFilePreviewsSchema = z.array(filePreviewSchema.nullable().catch(null))
  .catch([])
  .transform((files) => files.filter((file) => file !== null));
