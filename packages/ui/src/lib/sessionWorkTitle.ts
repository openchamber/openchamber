import { z } from 'zod';
import type { Metadata } from '@/lib/opencode/model';

/**
 * Session-title ownership, retained for carrying a user's explicit title into
 * a new worktree. `work.name` never changes session titles.
 */
const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

const workTitleSchema = z.object({ title: z.string().trim().min(1) });
const userWorkTitleSchema = workTitleSchema.extend({ by: z.literal('user') });

/** Ownership of a session title carried into a new worktree. */
export function carriedWorkTitleOwner(metadata: Metadata | undefined): 'user' | 'agent' {
  const value = userWorkTitleSchema.safeParse(openchamberSchema.safeParse(metadata).data?.openchamber.workTitle);
  return value.success ? 'user' : 'agent';
}

/** The metadata after the user named the session `title`. */
export function withUserWorkTitle(metadata: Metadata, title: string): Metadata {
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  return { ...metadata, openchamber: { ...namespace, workTitle: { title, by: 'user' } } };
}
