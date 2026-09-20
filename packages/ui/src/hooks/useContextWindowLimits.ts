import React from 'react';

import {
  findAnsweringModelKey,
  limitsForAnsweringModel,
  type ContextWindowLimits,
} from '@/lib/routing/contextWindowLimits';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectorySync } from '@/sync/sync-context';

/**
 * Which model's window the context readouts measure against.
 *
 * The fill itself comes from the newest answer, so the ratio is taken against
 * the window of the model that produced it — the same rule the context
 * overview applies, so no two readouts of one session disagree. The composer's
 * model only stands in before the first answer. Under Auto the composer names
 * no real model at all (the server picks one per turn), so the answering model
 * is the only one that can be measured against; without it Auto reads as "no
 * limit" and the readouts divide by the 200k default.
 */
export const useContextWindowLimits = (sessionId: string | null, directory?: string): ContextWindowLimits => {
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const providers = useConfigStore((state) => state.providers);

  // A `provider/model` string, so the caller re-renders only when the
  // answering model changes, not on every streamed part.
  const answeringModelKey = useDirectorySync(
    React.useCallback((state) => (
      sessionId ? findAnsweringModelKey(state.message[sessionId] ?? []) : null
    ), [sessionId]),
    directory,
  );

  return React.useMemo(() => {
    const answering = limitsForAnsweringModel(answeringModelKey, providers);
    if (answering.context > 0) return answering;
    const limit = getCurrentModel()?.limit;
    return { context: limit?.context ?? 0, output: limit?.output ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the getter's output tracks the selected model ids
  }, [answeringModelKey, currentProviderId, currentModelId, getCurrentModel, providers]);
};
