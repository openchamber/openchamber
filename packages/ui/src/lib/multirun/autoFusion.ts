import React from 'react';
import { toast } from '@/components/ui';
import { useConfigStore } from '@/stores/useConfigStore';
import { hasActiveSubagent, subscribeSessionStatusTransitions, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useI18n } from '@/lib/i18n';
import { NoFusionOutputsError, startRunFusion, type FusionJudge } from './fusion';
import type { MultiRunSummary } from './runs';
import { useMultiRunSessions } from './useMultiRuns';
import { RUN_LAUNCHER_ID } from './launcher';

/** Resolves the judge's display name and context window from the provider catalog. */
export const resolveFusionJudge = (selection: { providerID: string; modelID: string; variant?: string; agent?: string }): FusionJudge => {
  const provider = useConfigStore.getState().providers.find((entry) => entry.id === selection.providerID);
  const model = provider?.models.find((entry) => entry.id === selection.modelID);
  return {
    ...selection,
    modelName: model?.name || selection.modelID,
    contextLimit: model?.limit?.context || undefined,
  };
};

const startedRunKeys = new Set<string>();
// Lanes seen running on this page. A lane is finished only after it was seen
// running and then left the live busy set with an outcome. A parent idling for
// a subagent must record a newer completion before its answer can be fused.
const seenRunningLaneIds = new Set<string>();
const waitingLaneIdleTimes = new Map<string, number | undefined>();
const waitingForResumptionLaneIds = new Set<string>();

type FusionStart = (run: MultiRunSummary) => Promise<void>;
export type AutoFusionFailure = 'no-outputs' | 'failed';

function useRunAutoFusion(onStartFailed: (failure: AutoFusionFailure) => void): void {
  const { index, sessionById } = useMultiRunSessions();
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const failureRef = React.useRef(onStartFailed);
  failureRef.current = onStartFailed;

  React.useEffect(() => subscribeSessionStatusTransitions((sessionId, activeIds) => {
    for (const run of index.runs.values()) {
      if (run.autoFusion?.launcherId !== RUN_LAUNCHER_ID || startedRunKeys.has(run.key) || run.fusions.length > 0) continue;
      for (const lane of run.lanes) {
        if (lane.sessionId !== sessionId) continue;
        if (activeIds.has(sessionId)) {
          seenRunningLaneIds.add(sessionId);
          // A resumed parent may finish again before this batch reaches React.
          waitingForResumptionLaneIds.delete(sessionId);
          waitingLaneIdleTimes.delete(sessionId);
        } else if (hasActiveSubagent(sessionId, activeIds, (id) => sessionById.get(id)?.parentID)) {
          waitingForResumptionLaneIds.add(sessionId);
        }
      }
    }
  }), [index, sessionById]);

  React.useEffect(() => {
    const start: FusionStart = async (run) => {
      const autoFusion = run.autoFusion;
      if (!autoFusion) return;
      startedRunKeys.add(run.key);
      try {
        await startRunFusion({
          run,
          sourceIds: run.lanes.map((lane) => lane.sessionId),
          judge: resolveFusionJudge(autoFusion),
          sessionById,
        });
      } catch (error) {
        console.error('[MultiRun] Auto-fusion failed to start', error);
        failureRef.current(error instanceof NoFusionOutputsError ? 'no-outputs' : 'failed');
      }
    };
    for (const run of index.runs.values()) {
      if (run.autoFusion?.launcherId !== RUN_LAUNCHER_ID || startedRunKeys.has(run.key) || run.fusions.length > 0) continue;
      for (const lane of run.lanes) {
        if (activeSessionIds.has(lane.sessionId)) seenRunningLaneIds.add(lane.sessionId);
        else if (hasActiveSubagent(lane.sessionId, activeSessionIds, (id) => sessionById.get(id)?.parentID)) {
          waitingLaneIdleTimes.set(lane.sessionId, sessionById.get(lane.sessionId)?.time.idle);
        }
      }
      const finished = run.lanes.every((lane) => (
        seenRunningLaneIds.has(lane.sessionId)
        && !activeSessionIds.has(lane.sessionId)
        && !waitingForResumptionLaneIds.has(lane.sessionId)
        && sessionById.get(lane.sessionId)?.outcome !== undefined
        && (!waitingLaneIdleTimes.has(lane.sessionId)
          || (sessionById.get(lane.sessionId)?.time.idle ?? 0) > (waitingLaneIdleTimes.get(lane.sessionId) ?? 0))
      ));
      if (finished) void start(run);
    }
  }, [activeSessionIds, index, sessionById]);
}

/** Mounted once per shell that can launch runs. */
export function RunAutoFusion(): null {
  const { t } = useI18n();
  useRunAutoFusion(React.useCallback((failure: AutoFusionFailure) => {
    toast.error(failure === 'no-outputs' ? t('multirun.fusion.toast.noOutputs') : t('multirun.fusion.toast.failed'));
  }, [t]));
  return null;
}
