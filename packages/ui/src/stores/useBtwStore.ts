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

/**
 * Whether a saved btw model can still be used, judged against the catalog the
 * model picker renders. Auto is never in that catalog: it is valid exactly
 * while routing can honour it, as `hasProviderModel` in useConfigStore says.
 * An empty catalog has not loaded (or failed to), so it cannot say a model is
 * gone: there is no check then and the saved model wins.
 */
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
  /** Live-catalog check; when omitted the saved model wins, as before. */
  isModelAvailable?: (model: BtwModelSelection) => boolean;
}): BtwSelection => {
  const selectable = agents.filter((agent) => !agent.hidden && (agent.mode === 'primary' || agent.mode === 'all'));
  const agent = selectable.find((candidate) => candidate.name === savedAgent)
    ?? selectable.find((candidate) => candidate.name === 'plan')
    ?? selectable[0];
  // A saved model from before a provider rename or catalog change must not
  // win over the composer's live one: the fork would be switched onto a slug
  // no provider serves and its first prompt dies without reaching the catch
  // that shows the failure toast (#4353).
  const savedUsable = savedModel !== null && (isModelAvailable === undefined || isModelAvailable(savedModel));
  return {
    agent: agent?.name,
    model: savedUsable ? savedModel : composerModel,
    variant: savedUsable ? savedVariant : composerVariant,
  };
};

/**
 * UI-only state for the `/btw` peek panel.
 *
 * The panel's identity is NOT stored here: it is derived from session
 * metadata (`openchamber.btwSessionID` on the parent — see
 * `sessionBtwMetadata`), so the panel appears only in the session `/btw` was
 * typed into and survives reloads. This store keeps only transient
 * per-parent presentation state that has no authoritative home:
 *
 * - `collapsed`: the panel is minimized to the composer chip; the composer
 *   talks to the main session again until it is expanded.
 * - `creating`: `/btw` is between submit and the parent-metadata link
 *   landing, so the panel can show its starting state immediately.
 * - `destroying`: close was clicked; hides the panel optimistically while the
 *   unlink/delete round-trip completes.
 * - `pending`: `/btw` has opened an unsent local composer. No fork exists yet.
 */
type BtwPanelUIState = {
  collapsed?: boolean;
  creating?: boolean;
  destroying?: boolean;
  pending?: boolean;
  /** The shield button's choice for the fork; absent means the new session takes the default from Settings. */
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
