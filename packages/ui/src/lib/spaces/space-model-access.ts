// Whether a message on a model may go to an isolated space, checked on "Send" before it leaves the
// composer: a message on a provider the space has no key for stays in the input with the reason
// instead of failing inside the space.
//
// A running space is judged by the journey list, which the host reads from the record and the
// gatekeeper, so the answer holds in every window and after a reload. Before a space runs, and
// while the creation in this window is still giving the access chosen in the dialog, only this
// window knows what the space will get: the providers chosen there, by the draft's waiting request
// and by the space's project directory. Without an answer from the host nothing is refused, and
// neither is a provider the grant dialog cannot give a key for, a browser login or OpenCode's own
// among them: the dialog would be a dead end, and such a model may work inside all the same.

import { SPACE_MODEL_PROVIDERS } from './model-access';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import type { SpaceEntry } from './spaces-api';

type SpaceModelRefusal = { spaceId: string; providerId: string; reason: 'not_granted' | 'needs_again' };

const chosenByDirectory = new Map<string, ReadonlySet<string>>();
const directoryByRequest = new Map<string, string>();

export const noteSpaceModelAccess = (target: { requestId: string; directory: string }, providers: readonly string[]): void => {
  chosenByDirectory.set(target.directory, new Set(providers));
  directoryByRequest.set(target.requestId, target.directory);
};

/** Forgets what creations in this window chose; the runtime they were made on is gone. */
export const resetSpaceModelAccess = (): void => {
  chosenByDirectory.clear();
  directoryByRequest.clear();
};

/** What the host says a running space holds for a provider; a gatekeeper that did not answer refuses nothing. */
const refusalFromList = (entry: SpaceEntry, providerId: string): SpaceModelRefusal | null => {
  if (entry.access === 'unknown') return null;
  const grant = entry.grants.find((candidate) => candidate.kind === 'model' && candidate.provider === providerId);
  if (!grant) return { spaceId: entry.id, providerId, reason: 'not_granted' };
  if (entry.needsAccess.includes(grant.id)) return { spaceId: entry.id, providerId, reason: 'needs_again' };
  return null;
};

/**
 * Why a message on this provider must not go to the space the target names, or null when it may
 * or the target is not a space. A draft names its target by the request it still waits on, or by
 * its directory; a session by its directory.
 */
export const spaceModelRefusal = (target: { requestId: string | null; directory: string | null }, providerId: string): SpaceModelRefusal | null => {
  if (!SPACE_MODEL_PROVIDERS.some((provider) => provider.id === providerId)) return null;
  const directory = (target.requestId ? directoryByRequest.get(target.requestId) : undefined) ?? target.directory;
  const spaceId = spaceIdOfDirectory(directory);
  if (!spaceId || !directory) return null;
  const { journey, creationAccess } = useSpacesStore.getState();
  const entry = journey?.get(spaceId);
  if (entry?.state === 'running' && creationAccess.get(spaceId)?.kind !== 'giving') return refusalFromList(entry, providerId);
  const chosen = chosenByDirectory.get(directory);
  if (chosen && !chosen.has(providerId)) return { spaceId, providerId, reason: 'not_granted' };
  return null;
};
