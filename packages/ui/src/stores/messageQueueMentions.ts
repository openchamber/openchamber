import { z } from 'zod';

export interface QueuedMentions {
    agentMention?: string;
    skills?: string[];
}

export const serverMentionFields = {
    agentMention: z.string().optional(),
    skills: z.array(z.string()).optional(),
};

export const copyQueuedMentions = (from: QueuedMentions, to: QueuedMentions): void => {
    if (from.agentMention) to.agentMention = from.agentMention;
    if (from.skills?.length) to.skills = from.skills;
};
