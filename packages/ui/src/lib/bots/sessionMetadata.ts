import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

const automationSchema = z.object({ openchamber: z.object({ automation: z.object({
  source: z.literal('bot'), projectId: z.string().min(1), botId: z.string().min(1), itemId: z.string().min(1),
  stage: z.enum(['investigation', 'fixing', 'judge']),
}) }) });

export const botAutomation = (session: Session | undefined) => automationSchema.safeParse(session?.metadata).data?.openchamber.automation ?? null;

/** Metadata owns membership. Child sessions inherit visibility even without their own marker. */
export function botSessionIds(sessions: readonly Session[]): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const session of sessions) {
    if (botAutomation(session)) ids.add(session.id);
    if (session.parentID) {
      const siblings = children.get(session.parentID) ?? [];
      siblings.push(session.id);
      children.set(session.parentID, siblings);
    }
  }
  const queue = [...ids];
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of children.get(queue[index]) ?? []) {
      if (ids.has(id)) continue;
      ids.add(id);
      queue.push(id);
    }
  }
  return ids;
}

export function botSessionOwner(sessionId: string, sessions: ReadonlyMap<string, Session>) {
  const visited = new Set<string>();
  let session = sessions.get(sessionId);
  while (session && !visited.has(session.id)) {
    visited.add(session.id);
    const owner = botAutomation(session);
    if (owner) return owner;
    session = session.parentID ? sessions.get(session.parentID) : undefined;
  }
  return null;
}
