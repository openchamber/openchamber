import React from 'react';

import {
  findAnsweringModelKey,
  findSessionModelKey,
  limitsForAnsweringModel,
  type ContextWindowLimits,
} from '@/lib/routing/contextWindowLimits';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectorySync } from '@/sync/sync-context';

export const useContextWindowLimits = (sessionId: string | null, directory?: string): ContextWindowLimits => {
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const providers = useConfigStore((state) => state.providers);

  const sessionModelKey = useDirectorySync(
    React.useCallback((state) => (
      sessionId ? findSessionModelKey(state.session.find((candidate) => candidate.id === sessionId)) : null
    ), [sessionId]),
    directory,
  );
  const answeringModelKey = useDirectorySync(
    React.useCallback((state) => (
      sessionId ? findAnsweringModelKey(state.message[sessionId] ?? []) : null
    ), [sessionId]),
    directory,
  );

  return React.useMemo(() => {
    const onRecord = limitsForAnsweringModel(sessionModelKey, providers);
    if (onRecord.context > 0) return onRecord;
    const answering = limitsForAnsweringModel(answeringModelKey, providers);
    if (answering.context > 0) return answering;
    const limit = getCurrentModel()?.limit;
    return { context: limit?.context ?? 0, output: limit?.output ?? 0 };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the getter's output tracks the selected model ids
  }, [sessionModelKey, answeringModelKey, currentProviderId, currentModelId, getCurrentModel, providers]);
};
