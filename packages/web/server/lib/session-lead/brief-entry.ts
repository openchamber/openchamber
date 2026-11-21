import { createOneAtATime } from './one-at-a-time.js';
import type { LeadBriefStore } from './brief-store.js';

interface LeadBriefEntryOptions {
  briefs: Pick<LeadBriefStore, 'read' | 'readDelivered' | 'writeDelivered' | 'forgetDelivered'>;
  putEntry: (sessionId: string, directory: string, brief: string) => Promise<boolean>;
}

const NO_BRIEF = '';

export const createLeadBriefEntry = ({ briefs, putEntry }: LeadBriefEntryOptions) => {
  const oneAtATime = createOneAtATime();

  const forEntry = (sessionId: string) => oneAtATime(sessionId, async () => {
    const delivered = await briefs.readDelivered(sessionId);
    if (delivered !== null) return delivered === NO_BRIEF ? null : delivered;
    const current = await briefs.read(sessionId);
    await briefs.writeDelivered(sessionId, current ?? NO_BRIEF);
    return current;
  });

  const refresh = (sessionId: string, directory: string, isLead: boolean) => oneAtATime(sessionId, async () => {
    if (!isLead) {
      await briefs.forgetDelivered(sessionId);
      return;
    }
    const current = await briefs.read(sessionId);
    if (current === null) return;
    await briefs.writeDelivered(sessionId, current);
    await putEntry(sessionId, directory, current);
  });

  return { forEntry, refresh };
};
