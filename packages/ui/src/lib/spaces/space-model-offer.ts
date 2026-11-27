import React from 'react';

import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import type { SpaceEntry } from './spaces-api';

export const OPENCODE_PROVIDER_ID = 'opencode';

const chosenByDirectory = new Map<string, ReadonlySet<string>>();
const directoryByRequest = new Map<string, string>();

export type SpaceTarget = { requestId: string | null; directory: string | null };

export const spaceOfTarget = (target: SpaceTarget): { spaceId: string; directory: string } | null => {
  const directory = (target.requestId ? directoryByRequest.get(target.requestId) : undefined) ?? target.directory;
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId && directory ? { spaceId, directory } : null;
};

export const noteSpaceModelAccess = (target: { requestId: string; directory: string }, providers: readonly string[]): void => {
  chosenByDirectory.set(target.directory, new Set(providers));
  directoryByRequest.set(target.requestId, target.directory);
};

export const resetSpaceModelAccess = (): void => {
  chosenByDirectory.clear();
  directoryByRequest.clear();
};

export const chosenModelAccess = (directory: string): ReadonlySet<string> | undefined => chosenByDirectory.get(directory);

export type SpaceModelOffer = {
  spaceId: string;
  held: readonly string[] | null;
  needsAgain: readonly string[];
  give: 'now' | 'after_start' | null;
};

const offerOf = (space: { spaceId: string; directory: string }, entry: SpaceEntry | undefined): SpaceModelOffer => {
  const { spaceId } = space;
  const unknown = (give: SpaceModelOffer['give']): SpaceModelOffer => ({ spaceId, held: null, needsAgain: [], give });
  if (!entry) return unknown(null);
  const chosen = chosenByDirectory.get(space.directory);
  if (entry.state === 'preparing') return chosen ? { spaceId, held: [...chosen], needsAgain: [], give: null } : unknown(null);
  if (entry.state !== 'running' && entry.state !== 'exited') return unknown(null);
  const give = entry.damage === 'gatekeeper_gone' ? null : entry.state === 'running' ? 'now' : 'after_start';
  if (entry.access === 'unknown' || entry.network === null) return unknown(give);
  const grants = entry.grants.flatMap((grant) => (grant.kind === 'domain' ? [] : [grant]));
  if (entry.state === 'running' && grants.length === 0 && entry.accessFailures.length === 0 && chosen && chosen.size > 0) return { spaceId, held: [...chosen], needsAgain: [], give };
  const lost = (grant: (typeof grants)[number]) => entry.needsAccess.includes(grant.id)
    || (entry.state === 'exited' && grant.kind === 'model' && grant.source.kind === 'typed');
  const providersOf = (list: typeof grants) => list.map((grant) => grant.provider);
  return { spaceId, held: providersOf(grants.filter((grant) => !lost(grant))), needsAgain: providersOf(grants.filter(lost)), give };
};

export const spaceModelOffer = (target: SpaceTarget | null): SpaceModelOffer | null => {
  const space = target ? spaceOfTarget(target) : null;
  return space ? offerOf(space, useSpacesStore.getState().journey?.get(space.spaceId)) : null;
};

export const useSpaceModelOffer = (target: SpaceTarget | null): SpaceModelOffer | null => {
  const space = target ? spaceOfTarget(target) : null;
  const spaceId = space?.spaceId ?? null;
  const directory = space?.directory ?? null;
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  return React.useMemo(() => (spaceId && directory ? offerOf({ spaceId, directory }, entry) : null), [directory, entry, spaceId]);
};

export const spaceOfferAllows = (offer: SpaceModelOffer | null, providerId: string): boolean => {
  if (!offer) return true;
  if (providerId === OPENCODE_PROVIDER_ID) return false;
  return offer.held === null || offer.held.includes(providerId);
};

export const providersOfSpaceOffer = <P extends { id: string }>(offer: SpaceModelOffer | null, providers: P[]): P[] => (
  offer ? providers.filter((provider) => spaceOfferAllows(offer, provider.id)) : providers
);

type SessionTargetState = Pick<ReturnType<typeof useSessionUIStore.getState>, 'currentSessionId' | 'getDirectoryForSession' | 'newSessionDraft'>;

const activeRequestIdOf = (state: SessionTargetState): string | null => (
  !state.currentSessionId && state.newSessionDraft?.open ? state.newSessionDraft.pendingWorktreeRequestId ?? null : null
);

const activeDirectoryOf = (state: SessionTargetState): string | null => {
  if (state.currentSessionId) return state.getDirectoryForSession(state.currentSessionId);
  return state.newSessionDraft?.open ? state.newSessionDraft.directoryOverride ?? null : null;
};

export const activeSpaceTarget = (): SpaceTarget => {
  const state = useSessionUIStore.getState();
  return { requestId: activeRequestIdOf(state), directory: activeDirectoryOf(state) };
};

export const useActiveSpaceTarget = (): SpaceTarget => {
  const requestId = useSessionUIStore(activeRequestIdOf);
  const directory = useSessionUIStore(activeDirectoryOf);
  return React.useMemo(() => ({ requestId, directory }), [directory, requestId]);
};

type CatalogProvider = { id: string; models: readonly { modelID: string }[] };
export type ModelChoice = { providerId: string; modelId: string };

const modelAmong = (providers: readonly string[], catalog: readonly CatalogProvider[]): ModelChoice | null => {
  const { recentModels, hiddenModels } = useUIStore.getState();
  for (const providerId of providers) {
    const provider = catalog.find((entry) => entry.id === providerId);
    if (!provider) continue;
    const shown = (modelId: string) => !hiddenModels.some((hidden) => hidden.providerID === providerId && hidden.modelID === modelId);
    const recent = recentModels.find((entry) => entry.providerID === providerId && shown(entry.modelID) && provider.models.some((model) => model.modelID === entry.modelID));
    if (recent) return { providerId, modelId: recent.modelID };
    const visible = provider.models.find((model) => shown(model.modelID));
    if (visible) return { providerId, modelId: visible.modelID };
  }
  return null;
};

export const modelForSpaceOffer = (offer: SpaceModelOffer | null, catalog: readonly CatalogProvider[]): ModelChoice | null => (
  offer?.held ? modelAmong(offer.held, catalog) : null
);

export const composerModelForSpaceAccess = (providers: readonly string[]): ModelChoice | null => {
  const { providers: catalog, currentProviderId } = useConfigStore.getState();
  return providers.includes(currentProviderId) ? null : modelAmong(providers, catalog);
};
