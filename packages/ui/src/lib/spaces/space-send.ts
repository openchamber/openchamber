import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { composerModelForSpace, followSpaceModel, spaceModelRefusal } from './space-model-access';
import { useSpacesStore } from './spaces-store';

export type PendingSpaceSend = { spaceId: string; directory: string | null; sessionId: string | null; draftKey: string };

type PendingSpaceSendStep = 'wait' | 'drop' | 'follow' | 'send';

type Composer = { draftKey: string | null; providerId: string; modelId: string };

const takesProvider = (pending: PendingSpaceSend, providerId: string): boolean =>
  pending.directory === null || spaceModelRefusal({ requestId: null, directory: pending.directory }, providerId) === null;

const sessionModelOf = (pending: PendingSpaceSend): { providerId: string; modelId: string } | null => {
  const model = pending.sessionId ? useGlobalSessionsStore.getState().activeSessions.find((session) => session.id === pending.sessionId)?.model : undefined;
  const listed = model && useConfigStore.getState().providers.find((provider) => provider.id === model.providerID)?.models.some((entry) => entry.modelID === model.id);
  return model && listed && takesProvider(pending, model.providerID) ? { providerId: model.providerID, modelId: model.id } : null;
};

export const pendingSpaceSendStep = (pending: PendingSpaceSend, composer: Composer): PendingSpaceSendStep => {
  const { journey, actions } = useSpacesStore.getState();
  if (composer.draftKey !== pending.draftKey || actions.get(pending.spaceId)?.kind === 'failed') return 'drop';
  if (journey?.get(pending.spaceId)?.state !== 'running' || actions.get(pending.spaceId)?.kind === 'running') return 'wait';
  if (!composer.providerId || !composer.modelId) return 'wait';
  if (takesProvider(pending, composer.providerId) || composer.providerId !== useConfigStore.getState().currentProviderId) return 'send';
  const replacement = sessionModelOf(pending) ?? (pending.directory ? composerModelForSpace(pending.directory) : null);
  return replacement ? 'follow' : 'send';
};

export const followPendingSpaceModel = (pending: PendingSpaceSend): void => {
  const sessionModel = sessionModelOf(pending);
  if (sessionModel) {
    useConfigStore.getState().setProvider(sessionModel.providerId);
    useConfigStore.getState().setModel(sessionModel.modelId);
  } else if (pending.directory) {
    followSpaceModel(pending.directory);
  }
};
