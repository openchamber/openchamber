// external: https://opencode.ai/docs/zen/#endpoints Free-tier models reject requests from isolated spaces; no grant changes this.

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

type SpaceTarget = { requestId: string | null; directory: string | null };

const spaceOfTarget = (target: SpaceTarget): { spaceId: string; directory: string } | null => {
  const directory = (target.requestId ? directoryByRequest.get(target.requestId) : undefined) ?? target.directory;
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId && directory ? { spaceId, directory } : null;
};

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

export const resetSpaceModelAccess = (): void => {
  chosenByDirectory.clear();
  directoryByRequest.clear();
};

const refusalFromList = (entry: SpaceEntry, providerId: string): SpaceModelRefusal | null => {
  if (entry.access === 'unknown') return null;
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
  const { journey, customProviders, catalogProviders } = useSpacesStore.getState();
  const entry = journey?.get(spaceId);
  const listed = (providers: readonly { id: string; supported: boolean }[] | undefined) => providers?.some((provider) => provider.id === providerId && provider.supported) === true;
  const grantable = entry?.projectDirectory ? listed(customProviders.get(entry.projectDirectory)) || listed(catalogProviders.get(entry.projectDirectory)) : false;
  if (!grantable && !isSpaceGrantableProvider(providerId)) return null;
  if (entry?.state === 'running') return refusalFromList(entry, providerId);
  const chosen = chosenByDirectory.get(directory);
  if (chosen && !chosen.has(providerId)) return { spaceId, providerId, reason: 'not_granted' };
  return null;
};

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

export const composerModelForSpace = (directory: string): { providerId: string; modelId: string } | null => {
  const spaceId = spaceIdOfDirectory(directory);
  const entry = spaceId ? useSpacesStore.getState().journey?.get(spaceId) : undefined;
  if (!entry || entry.state !== 'running') return null;
  const { currentProviderId } = useConfigStore.getState();
  if (!spaceModelRefusal({ requestId: null, directory }, currentProviderId)) return null;
  const held = entry.grants.flatMap((grant) => ((grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom') && !entry.needsAccess.includes(grant.id) ? [grant.provider] : []));
  return composerModelForSpaceAccess(held);
};
