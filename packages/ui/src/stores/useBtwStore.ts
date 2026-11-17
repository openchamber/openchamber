import type { PermissionMode } from './utils/permissionAutoAccept';
import { create } from 'zustand';
import { findCatalogModel, type Agent } from '@/lib/opencode/model';
import { isAutoModel } from '@/lib/routing/autoModel';

type BtwModelSelection = { providerId: string; modelId: string };
export type BtwSelection = {
  agent: string | undefined;
  model: BtwModelSelection | null;
  variant: string | null | undefined;
};

export const btwModelAvailability = (
  providers: readonly { id: string; models: readonly { id: string; modelID: string }[] }[],
  autoReady: boolean,
): ((model: BtwModelSelection) => boolean) | undefined => {
  if (providers.length === 0) return undefined;
  return ({ providerId, modelId }) => {
    if (isAutoModel(providerId, modelId)) return autoReady;
    const provider = providers.find((candidate) => candidate.id === providerId);
    return Boolean(provider && findCatalogModel(provider.models, modelId));
  };
};

export const resolveBtwSelection = ({ agents, savedAgent, savedModel, savedVariant, composerModel, composerVariant, isModelAvailable }: {
  agents: readonly Pick<Agent, 'name' | 'hidden' | 'mode'>[];
  savedAgent: string | null;
  savedModel: BtwModelSelection | null;
  savedVariant?: string | null;
  composerModel: BtwModelSelection | null;
  composerVariant: string | null | undefined;
  isModelAvailable?: (model: BtwModelSelection) => boolean;
}): BtwSelection => {
  const selectable = agents.filter((agent) => !agent.hidden && (agent.mode === 'primary' || agent.mode === 'all'));
  const agent = selectable.find((candidate) => candidate.name === savedAgent)
    ?? selectable.find((candidate) => candidate.name === 'plan')
    ?? selectable[0];
  const savedUsable = savedModel !== null && (isModelAvailable === undefined || isModelAvailable(savedModel));
  return {
    agent: agent?.name,
    model: savedUsable ? savedModel : composerModel,
    variant: savedUsable ? savedVariant : composerVariant,
  };
};

type BtwPanelUIState = {
  collapsed?: boolean;
  creating?: boolean;
  destroying?: boolean;
  pending?: boolean;
  pendingPermissionMode?: PermissionMode;
  pendingSend?: symbol;
};

type BtwStore = {
  byParent: Record<string, BtwPanelUIState>;
  setPanelState: (parentSessionId: string, patch: BtwPanelUIState) => void;
  clearPanelState: (parentSessionId: string) => void;
};

export const useBtwStore = create<BtwStore>()((set) => ({
  byParent: {},
  setPanelState: (parentSessionId, patch) =>
    set((state) => ({
      byParent: {
        ...state.byParent,
        [parentSessionId]: { ...state.byParent[parentSessionId], ...patch },
      },
    })),
  clearPanelState: (parentSessionId) =>
    set((state) => {
      if (!(parentSessionId in state.byParent)) return state;
      const byParent = { ...state.byParent };
      delete byParent[parentSessionId];
      return { byParent };
    }),
}));
