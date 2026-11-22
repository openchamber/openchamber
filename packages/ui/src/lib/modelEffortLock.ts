/**
 * A model's locked effort: the one every message to it runs at, whatever the
 * composer picked. OpenChamber's own lock (Settings, a model's options) comes
 * first, then OpenCode's config (`lockVariant`), which a recent OpenCode also
 * enforces on its side; OpenChamber sends it explicitly so an older one does too.
 */
import {
  openCodeLockedVariant,
  useLoadedOpenCodeModelSettings,
  useOpenCodeModelSettings,
  type OpenCodeModelSettings,
} from '@/lib/opencodeModelSettings';
import { useUIStore } from '@/stores/useUIStore';

type LockSources = {
  modelDefaultVariants: Record<string, string>;
  modelDefaultVariantLocks: readonly string[];
  opencode: Record<string, OpenCodeModelSettings>;
};

const lockedVariantFor = (sources: LockSources, providerId: string | undefined, modelId: string | undefined) => {
  if (!providerId || !modelId) return undefined;
  const key = `${providerId}/${modelId}`;
  const app = sources.modelDefaultVariantLocks.includes(key) ? sources.modelDefaultVariants[key] : undefined;
  return app ?? openCodeLockedVariant(sources.opencode[key]);
};

/** The locked effort for one model, read from the current stores. */
export const readLockedVariant = (providerId: string | undefined, modelId: string | undefined) => {
  const ui = useUIStore.getState();
  return lockedVariantFor(
    {
      modelDefaultVariants: ui.modelDefaultVariants,
      modelDefaultVariantLocks: ui.modelDefaultVariantLocks,
      opencode: useOpenCodeModelSettings.getState().models,
    },
    providerId,
    modelId,
  );
};

/** The locked effort for one model, kept current as either store changes. */
export const useLockedVariant = (providerId: string | undefined, modelId: string | undefined) => {
  // OpenCode's lock is in its config; the composer reads it without waiting for a picker to open.
  useLoadedOpenCodeModelSettings();
  const key = providerId && modelId ? `${providerId}/${modelId}` : '';
  const app = useUIStore((state) => (key && state.modelDefaultVariantLocks.includes(key) ? state.modelDefaultVariants[key] : undefined));
  const opencode = useOpenCodeModelSettings((state) => (key ? openCodeLockedVariant(state.models[key]) : undefined));
  return app ?? opencode;
};
