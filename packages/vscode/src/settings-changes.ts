import { z } from 'zod';

// Invalid fields are omitted independently so one malformed preference cannot
// discard the other preference or any unrelated settings in the same write.
export const enterSettingsSchema = z.object({
  enterToSend: z.boolean().optional().catch(undefined),
  enterToSendConfigured: z.boolean().optional().catch(undefined),
});
