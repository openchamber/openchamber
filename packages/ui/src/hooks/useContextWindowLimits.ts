import React from 'react';

import {
  findAnsweringModelKey,
  findSessionModelKey,
  limitsForAnsweringModel,
  type ContextWindowLimits,
} from '@/lib/routing/contextWindowLimits';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectorySync } from '@/sync/sync-context';

/**
 * Which model's window the context readouts measure against.
 *
 * OpenCode 2.x keeps the model on the session record, and that is what the
 * next turn runs on: a manual switch and an Auto-routed turn both land there
 * before any answer exists, so the record is measured against first. The
 * newest answer's model stands in when the record names none (older sessions),
 * and the composer's model only before the first answer. Under Auto the
 * composer names no real model at all (the server picks one per turn), so
 * without the record or an answer Auto reads as "no limit" and the readouts
 * divide by the 200k default.
 */
export const useContextWindowLimits = (sessionId: string | null, directory?: string): ContextWindowLimits => {
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const providers = useConfigStore((state) => state.providers);

  // `provider/model` strings, so the caller re-renders only when the model
  // changes, not on every streamed part.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the getter's output tracks the selected model ids
  }, [sessionModelKey, answeringModelKey, currentProviderId, currentModelId, getCurrentModel, providers]);
};
