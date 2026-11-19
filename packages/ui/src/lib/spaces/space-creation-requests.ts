
import type { SpaceEntry } from './spaces-api';

const spaceRequests = new Map<string, string>();

export const noteSpaceCreationRequest = (requestId: string, spaceId: string): void => {
  spaceRequests.set(requestId, spaceId);
};

export const forgetSpaceCreationRequest = (requestId: string): void => {
  spaceRequests.delete(requestId);
};

export const resetSpaceCreationRequests = (): void => {
  spaceRequests.clear();
};

export const isSpaceCreationRequest = (requestId: string | null | undefined): boolean => Boolean(requestId && spaceRequests.has(requestId));

export const spaceOfCreationRequest = (requestId: string | null | undefined): string | null => (requestId ? spaceRequests.get(requestId) ?? null : null);

export type DraftSpaceTarget = { kind: 'preparing' } | { kind: 'ready'; directory: string };

export const draftSpaceTarget = (requestId: string | null | undefined, journey: ReadonlyMap<string, SpaceEntry> | null): DraftSpaceTarget | null => {
  const spaceId = spaceOfCreationRequest(requestId);
  if (!spaceId) return null;
  const entry = journey?.get(spaceId);
  return entry?.state === 'running' && entry.directory ? { kind: 'ready', directory: entry.directory } : { kind: 'preparing' };
};

export const panelContentDirectory = (draftSpace: DraftSpaceTarget | null, own: string | null | undefined): string | null => (
  draftSpace ? (draftSpace.kind === 'ready' ? draftSpace.directory : null) : own ?? null
);
