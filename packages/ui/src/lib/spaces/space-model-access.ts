// Whether a message on a model may go to an isolated space, checked on "Send" before it leaves the
// composer: a message on a provider the space has no key for stays in the input with the reason
// instead of failing inside the space, and so does a message to a space the journey list says is
// stopped, with "Start" as the way on.
//
// A running space is judged by the journey list, which the host reads from the record and the
// gatekeeper, so the answer holds in every window and after a reload. Before a space runs, and
// while the creation in this window is still giving the access chosen in the dialog, only this
// window knows what the space will get: the providers chosen there, by the draft's waiting request
// and by the space's project directory. Without an answer from the host nothing is refused, and
// neither is a provider the grant dialog cannot give a key for, a browser login or OpenCode's own
// among them: the dialog would be a dead end, and such a model may work inside all the same.
// One exception: OpenCode's own provider reaches opencode.ai, which a space that allows only
// chosen addresses blocks unless that name is on its list, so the message would fail inside
// with a bare 403; it stays in the composer with the name to allow instead.

import { SPACE_MODEL_PROVIDERS } from './model-access';
import { spaceMenuActionsOf } from './space-repair';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import type { SpaceEntry } from './spaces-api';

type SpaceModelRefusal =
  | { spaceId: string; providerId: string; reason: 'not_granted' | 'needs_again' }
  | { spaceId: string; providerId: string; reason: 'domain_blocked'; domain: string };

/** The address a provider the dialog cannot grant talks to, for the providers whose address is known. */
const UNGRANTABLE_PROVIDER_DOMAINS = new Map([['opencode', 'opencode.ai']]);

const chosenByDirectory = new Map<string, ReadonlySet<string>>();
const directoryByRequest = new Map<string, string>();

/** The space a draft or session targets: by the request it still waits on, or by its directory. */
type SpaceTarget = { requestId: string | null; directory: string | null };

const spaceOfTarget = (target: SpaceTarget): { spaceId: string; directory: string } | null => {
  const directory = (target.requestId ? directoryByRequest.get(target.requestId) : undefined) ?? target.directory;
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId && directory ? { spaceId, directory } : null;
};

/**
 * The space a message targets when the journey list says it cannot take one: stopped, or its
 * container gone. Checked before any model is looked at: nothing inside can answer, and the
 * composer may not even have a model for the space, whose catalog does not load meanwhile. The
 * same rule as `isSpaceDirectoryStopped`, which pauses the polls. `start` says whether "Start" is
 * the way on, as the group's menu decides it: a stopped space whose gatekeeper is gone never starts
 * again, and a space whose container is gone can only be deleted.
 */
type StoppedSpace = { spaceId: string; reason: 'stopped' | 'gone'; start: boolean };

export const stoppedSpaceOfTarget = (target: SpaceTarget): StoppedSpace | null => {
  const space = spaceOfTarget(target);
  if (!space) return null;
  const entry = useSpacesStore.getState().journey?.get(space.spaceId);
  if (entry?.state !== 'exited' && entry?.state !== 'missing') return null;
  return { spaceId: space.spaceId, reason: entry.state === 'exited' ? 'stopped' : 'gone', start: spaceMenuActionsOf(entry).includes('start') };
};

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
export const spaceModelRefusal = (target: SpaceTarget, providerId: string): SpaceModelRefusal | null => {
  const grantable = SPACE_MODEL_PROVIDERS.some((provider) => provider.id === providerId);
  const domain = UNGRANTABLE_PROVIDER_DOMAINS.get(providerId);
  if (!grantable && !domain) return null;
  const space = spaceOfTarget(target);
  if (!space) return null;
  const { spaceId, directory } = space;
  const { journey, creationAccess } = useSpacesStore.getState();
  const entry = journey?.get(spaceId);
  if (!grantable && domain !== undefined) {
    // A space that is not listed yet, or whose network the host could not read, refuses nothing.
    if (entry?.network?.mode !== 'allowlist' || entry.network.domains.includes(domain)) return null;
    return { spaceId, providerId, reason: 'domain_blocked', domain };
  }
  if (entry?.state === 'running' && creationAccess.get(spaceId)?.kind !== 'giving') return refusalFromList(entry, providerId);
  const chosen = chosenByDirectory.get(directory);
  if (chosen && !chosen.has(providerId)) return { spaceId, providerId, reason: 'not_granted' };
  return null;
};
