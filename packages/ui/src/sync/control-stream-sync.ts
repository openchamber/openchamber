import { subscribeOpenchamberEvents, type ControlStreamSyncEvent } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { shareAnswerToastFor, showShareAnswerToast } from './share-answer-toast';

export const subscribeControlStreamSync = (
  runtimeKey: string,
  apply: (event: ControlStreamSyncEvent) => void,
  showShareAnswer = showShareAnswerToast,
): (() => void) => subscribeOpenchamberEvents((event) => {
  if (runtimeKey !== getRuntimeKey()) return;
  if (event.type === 'notification') {
    const shareAnswer = shareAnswerToastFor(event.payload);
    if (shareAnswer) showShareAnswer(shareAnswer);
  } else if (event.type === 'event-stream-ready') {
    useWorkflowRunsStore.getState().reloadLoaded();
    void seedGlobalSessionStatusFromHost().catch(() => undefined);
  } else if (event.type === 'control-sync') {
    apply(event.event);
  }
});
