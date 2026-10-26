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
// One exception: OpenCode's own provider is refused in every space, whatever its network. Its
// free models refuse a request from inside a space, measured on 2026-10-14 with the open internet
// ("free tier can only be used from within OpenCode"), and no grant gives a space anything else.

import { isSpaceGrantableProvider } from './model-access';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { spaceMenuActionsOf } from './space-repair';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import { providerGrantOf, type SpaceEntry } from './spaces-api';

type SpaceModelRefusal = { spaceId: string; providerId: string; reason: 'not_granted' | 'needs_again' | 'opencode' };

const OPENCODE_PROVIDER_ID = 'opencode';

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
type StoppedSpace = { spaceId: string; reason: 'stopped' | 'gone' | 'unreachable'; start: boolean };

export const stoppedSpaceOfTarget = (target: SpaceTarget): StoppedSpace | null => {
  const space = spaceOfTarget(target);
  if (!space) return null;
  const entry = useSpacesStore.getState().journey?.get(space.spaceId);
  if (entry?.state !== 'exited' && entry?.state !== 'missing' && entry?.state !== 'unreachable') return null;
  const reason = entry.state === 'exited' ? 'stopped' : entry.state === 'missing' ? 'gone' : 'unreachable';
  return { spaceId: space.spaceId, reason, start: spaceMenuActionsOf(entry).includes('start') };
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
  const grant = providerGrantOf(entry.grants, providerId);
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
  const space = spaceOfTarget(target);
  if (!space) return null;
  const { spaceId, directory } = space;
  if (providerId === OPENCODE_PROVIDER_ID) return { spaceId, providerId, reason: 'opencode' };
  const { journey, customProviders } = useSpacesStore.getState();
  const entry = journey?.get(spaceId);
  // A provider of the user's own is grantable when the host lists it for the space's project;
  // a project not read yet refuses nothing, as the rule above says.
  const custom = entry?.projectDirectory ? customProviders.get(entry.projectDirectory)?.some((provider) => provider.id === providerId) === true : false;
  if (!custom && !isSpaceGrantableProvider(providerId)) return null;
  // The host gives the creation's access before it says "ready", so a running space is judged by the list.
  if (entry?.state === 'running') return refusalFromList(entry, providerId);
  const chosen = chosenByDirectory.get(directory);
  if (chosen && !chosen.has(providerId)) return { spaceId, providerId, reason: 'not_granted' };
  return null;
};

/**
 * The model the composer moves to when a new space is given access to `providers` and the
 * composer's model is on none of them: otherwise the first message on it would only come back
 * with a refusal. The model last used of the first such provider the catalog has, else its first
 * model the user did not hide; null when the composer's provider is among them or none is known.
 */
export const composerModelForSpaceAccess = (providers: readonly string[]): { providerId: string; modelId: string } | null => {
  const { providers: catalog, currentProviderId } = useConfigStore.getState();
  if (providers.length === 0 || providers.includes(currentProviderId)) return null;
  const { recentModels, hiddenModels } = useUIStore.getState();
  for (const providerId of providers) {
    const provider = catalog.find((entry) => entry.id === providerId);
    if (!provider) continue;
    const recent = recentModels.find((entry) => entry.providerID === providerId && provider.models.some((model) => model.modelID === entry.modelID));
    if (recent) return { providerId, modelId: recent.modelID };
    const visible = provider.models.find((model) => !hiddenModels.some((hidden) => hidden.providerID === providerId && hidden.modelID === model.modelID));
    if (visible) return { providerId, modelId: visible.modelID };
  }
  return null;
};
