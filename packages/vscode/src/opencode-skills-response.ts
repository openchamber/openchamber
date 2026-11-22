import { z } from 'zod';
import { OPENCODE_SKILLS_RESPONSE_MAX_BYTES, readBoundedResponseJson } from './bounded-response-body';

const skillEntrySchema = z.object({
  name: z.string().optional().catch(undefined),
  path: z.string().optional().catch(undefined),
  location: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  content: z.string().optional().catch(undefined),
});

const skillsPayloadSchema = z.object({ data: z.array(skillEntrySchema) });

type OpenCodeSkillsPayload = z.infer<typeof skillsPayloadSchema>;

export const readOpenCodeSkillsPayload = async (response: Response): Promise<OpenCodeSkillsPayload | null> => {
  try {
    return await readBoundedResponseJson(response, OPENCODE_SKILLS_RESPONSE_MAX_BYTES, skillsPayloadSchema);
  } catch {
    return null;
  }
};
