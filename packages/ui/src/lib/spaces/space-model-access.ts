// external: https://opencode.ai/docs/zen/#endpoints Free-tier models reject requests from isolated spaces; no grant changes this.

import { AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';
import { isSpaceGrantableProvider } from './model-access';
import { spaceMenuActionsOf } from './space-repair';
import { chosenModelAccess, OPENCODE_PROVIDER_ID, spaceModelOffer, spaceOfferAllows, spaceOfTarget, type SpaceTarget } from './space-model-offer';
import { useSpacesStore } from './spaces-store';
import { providerGrantOf, type SpaceEntry } from './spaces-api';

type SpaceModelRefusal = { spaceId: string; providerId: string; reason: 'not_granted' | 'needs_again' | 'opencode' };

export type StoppedSpace = { spaceId: string; reason: 'stopped' | 'gone' | 'unreachable'; start: boolean };

export const stoppedSpaceOfTarget = (target: SpaceTarget): StoppedSpace | null => {
  const space = spaceOfTarget(target);
  if (!space) return null;
  const entry = useSpacesStore.getState().journey?.get(space.spaceId);
  if (entry?.state !== 'exited' && entry?.state !== 'missing' && entry?.state !== 'unreachable') return null;
  const reason = entry.state === 'exited' ? 'stopped' : entry.state === 'missing' ? 'gone' : 'unreachable';
  return { spaceId: space.spaceId, reason, start: spaceMenuActionsOf(entry).includes('start') };
};

const refusalFromList = (entry: SpaceEntry, providerId: string): SpaceModelRefusal | null => {
  if (entry.access === 'unknown' || entry.network === null) return null;
  const grant = providerGrantOf(entry.grants, providerId);
  if (!grant) return { spaceId: entry.id, providerId, reason: 'not_granted' };
  if (entry.needsAccess.includes(grant.id)) return { spaceId: entry.id, providerId, reason: 'needs_again' };
  return null;
};

export const spaceModelRefusal = (target: SpaceTarget, providerId: string): SpaceModelRefusal | null => {
  const space = spaceOfTarget(target);
  if (!space) return null;
  const { spaceId, directory } = space;
  if (providerId === OPENCODE_PROVIDER_ID) return { spaceId, providerId, reason: 'opencode' };
  if (providerId === AUTO_PROVIDER_ID) return spaceOfferAllows(spaceModelOffer(target), providerId) ? null : { spaceId, providerId, reason: 'not_granted' };
  const { journey, customProviders, catalogProviders } = useSpacesStore.getState();
  const entry = journey?.get(spaceId);
  const listed = (providers: readonly { id: string; supported: boolean }[] | undefined) => providers?.some((provider) => provider.id === providerId && provider.supported) === true;
  const grantable = entry?.projectDirectory ? listed(customProviders.get(entry.projectDirectory)) || listed(catalogProviders.get(entry.projectDirectory)) : false;
  if (!grantable && !isSpaceGrantableProvider(providerId)) return null;
  if (entry?.state === 'running') return refusalFromList(entry, providerId);
  const chosen = chosenModelAccess(directory);
  if (chosen && !chosen.has(providerId)) return { spaceId, providerId, reason: 'not_granted' };
  return null;
};
