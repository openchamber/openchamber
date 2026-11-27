import { useConfigStore } from '@/stores/useConfigStore';
import { spaceModelRefusal } from './space-model-access';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';

export type SpaceSendModel = { providerId: string; modelId: string };

export type PendingSpaceSend = { spaceId: string; directory: string | null; draftKey: string; model: SpaceSendModel };

type PendingSpaceSendStep = 'wait' | 'drop' | 'send';

type Composer = { draftKey: string | null; providerId: string; modelId: string };

const takesProvider = (pending: PendingSpaceSend, providerId: string): boolean =>
  pending.directory === null || spaceModelRefusal({ requestId: null, directory: pending.directory }, providerId) === null;

export const pendingSpaceSendStep = (pending: PendingSpaceSend, composer: Composer): PendingSpaceSendStep => {
  const { journey, actions } = useSpacesStore.getState();
  if (composer.draftKey !== pending.draftKey || actions.get(pending.spaceId)?.kind === 'failed') return 'drop';
  if (journey?.get(pending.spaceId)?.state !== 'running' || actions.get(pending.spaceId)?.kind === 'running') return 'wait';
  if (!composer.providerId || !composer.modelId) return 'wait';
  if (takesProvider(pending, pending.model.providerId) && !takesProvider(pending, composer.providerId)) return 'wait';
  return 'send';
};

export const toSendModel = (model: { providerId?: string; modelId?: string } | null | undefined): SpaceSendModel | null => (
  model?.providerId && model.modelId ? { providerId: model.providerId, modelId: model.modelId } : null
);

export const settleShownSpaceModel = (model: SpaceSendModel, spaceId: string): void => {
  const config = useConfigStore.getState();
  if (spaceIdOfDirectory(config.activeDirectoryKey) !== spaceId) return;
  if (config.currentProviderId === model.providerId && config.currentModelId === model.modelId) config.setModel(model.modelId);
};
