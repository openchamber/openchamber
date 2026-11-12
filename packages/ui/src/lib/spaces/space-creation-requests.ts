// The draft requests that wait for a space rather than a worktree, by the space they wait for, so
// the draft can say which, and name the space once it is ready. Kept apart from the creation
// itself (`space-creation.ts`) so the screens that only read them, the terminal among them, do not
// load what a creation needs.

import type { SpaceEntry } from './spaces-api';

const spaceRequests = new Map<string, string>();

export const noteSpaceCreationRequest = (requestId: string, spaceId: string): void => {
  spaceRequests.set(requestId, spaceId);
};

export const forgetSpaceCreationRequest = (requestId: string): void => {
  spaceRequests.delete(requestId);
};

/** Forgets the waiting requests; the runtime their spaces were asked of is gone. */
export const resetSpaceCreationRequests = (): void => {
  spaceRequests.clear();
};

export const isSpaceCreationRequest = (requestId: string | null | undefined): boolean => Boolean(requestId && spaceRequests.has(requestId));

/** The space a draft waits for, or null when the draft waits for nothing of this kind. */
export const spaceOfCreationRequest = (requestId: string | null | undefined): string | null => (requestId ? spaceRequests.get(requestId) ?? null : null);

/** Where a draft waiting for a space runs commands: nowhere while the space is made, in the space once it runs. */
export type DraftSpaceTarget = { kind: 'preparing' } | { kind: 'ready'; directory: string };

/**
 * Where a draft that waits for a space runs its terminal and project actions, or null when the draft
 * waits for no space. The draft itself stays on the project's folder until its message is sent, but
 * its branch chip names the space, so commands follow the chip: one run on this computer would do
 * what the user means for the container. Running is what the chip reads as ready too.
 */
export const draftSpaceTarget = (requestId: string | null | undefined, journey: ReadonlyMap<string, SpaceEntry> | null): DraftSpaceTarget | null => {
  const spaceId = spaceOfCreationRequest(requestId);
  if (!spaceId) return null;
  const entry = journey?.get(spaceId);
  return entry?.state === 'running' && entry.directory ? { kind: 'ready', directory: entry.directory } : { kind: 'preparing' };
};

/**
 * The folder a panel shows, given the open view's own: that folder, or for a draft waiting for a
 * space, the space once it runs and none while it is made. The panel's tabs stay with the view's
 * own folder either way, as the draft does.
 */
export const panelContentDirectory = (draftSpace: DraftSpaceTarget | null, own: string | null | undefined): string | null => (
  draftSpace ? (draftSpace.kind === 'ready' ? draftSpace.directory : null) : own ?? null
);
