import React from 'react';

import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cancelGoalSpecJob, listGoalSpecJobs, type GoalSpecJob } from '@/lib/goalSpecJobs';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGoalSpecJobStore } from '@/stores/useGoalSpecJobStore';
import { openSessionFromToast } from '@/sync/session-navigation';

const toastId = (jobId: string) => `goal-spec-job-${jobId}`;

/**
 * Keeps the goal writer jobs ("Send when ready") current and shows each as a
 * toast: writing, with Cancel; failed or cancelled, with Open session, where
 * its composer takes the message back. Mounted once per window, by the main
 * composer. VS Code has no goal loop and no job routes.
 */
export const useGoalSpecJobSync = (enabled: boolean): void => {
  const { t } = useI18n();
  const tRef = React.useRef(t);
  tRef.current = t;

  React.useEffect(() => {
    if (!enabled || isVSCodeRuntime()) return;
    const store = useGoalSpecJobStore.getState;
    let generation = 0;
    const load = () => {
      const current = (generation += 1);
      // A failed read keeps what is held: an unread list is not "no jobs".
      void listGoalSpecJobs()
        .then((jobs) => { if (current === generation) store().replaceAll(jobs); })
        .catch((error: Error) => console.warn('[goal-spec-jobs] failed to read goal jobs:', error));
    };
    load();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      store().reset();
      load();
    });
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready') {
        load();
      } else if (event.type === 'goal-spec-job') {
        if ('job' in event.update) store().upsert(event.update.job);
        else store().remove(event.update.removed);
      }
    });
    return () => {
      generation += 1;
      unsubscribeRuntime();
      unsubscribeEvents();
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled || isVSCodeRuntime()) return;
    const shown = new Map<string, string>();
    const show = (job: GoalSpecJob) => {
      const key = `${job.status}:${job.cancelled}:${job.error ?? ''}`;
      if (shown.get(job.id) === key) return;
      shown.set(job.id, key);
      const translate = tRef.current;
      const openSession = { label: translate('chat.goal.writer.toast.openSession'), onClick: () => openSessionFromToast(job.sessionId, job.directory) };
      if (job.status === 'failed') {
        if (job.cancelled) toast.info(translate('chat.goal.writer.toast.backgroundCancelled'), { id: toastId(job.id), action: openSession });
        else toast.error(translate('chat.goal.writer.toast.backgroundFailed', { reason: job.error ?? '' }), { id: toastId(job.id), action: openSession });
        return;
      }
      toast.loading(translate('chat.goal.writer.toast.writingInBackground'), {
        id: toastId(job.id),
        action: {
          label: translate('chat.goal.action.cancel'),
          onClick: () => {
            void cancelGoalSpecJob(job)
              .then((cancelled) => useGoalSpecJobStore.getState().upsert(cancelled))
              .catch((error: Error) => toast.error(error.message));
          },
        },
      });
    };
    const sync = (jobs: Record<string, GoalSpecJob>) => {
      for (const job of Object.values(jobs)) show(job);
      for (const [id, key] of Array.from(shown.entries())) {
        if (jobs[id]) continue;
        shown.delete(id);
        // A failure stays on screen after its composer took the message back.
        if (!key.startsWith('failed:')) toast.dismiss(toastId(id));
      }
    };
    sync(useGoalSpecJobStore.getState().jobs);
    return useGoalSpecJobStore.subscribe((state) => sync(state.jobs));
  }, [enabled]);
};
