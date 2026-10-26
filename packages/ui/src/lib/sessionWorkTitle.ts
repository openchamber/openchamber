import { z } from 'zod';
import type { Metadata } from '@/lib/opencode/model';

/**
 * Who named a task in the main checkout, under `metadata.openchamber.workTitle`
 * of its root session: the agent through the openchamber tool's `work.name`,
 * or the user by renaming the session. The server reads it so an agent never
 * renames what the user named (`web/server/lib/openchamber-sessions/work-naming.js`).
 */
const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/** The metadata after the user named the session `title`. */
export function withUserWorkTitle(metadata: Metadata, title: string): Metadata {
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  return { ...metadata, openchamber: { ...namespace, workTitle: { title, by: 'user' } } };
}
