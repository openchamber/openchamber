import { subscribeOpenchamberEvents, type ControlStreamSyncEvent } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { shareAnswerToastFor, showShareAnswerToast } from './share-answer-toast';

/**
 * OpenChamber's own session announcements, from the control stream, and the
 * toast of an answer to a shared page: the main
 * event stream carries them over the WebSocket and never over SSE, which is
 * OpenCode's own stream. Changes during a gap are not replayed, so each
 * connection of the control stream reads the shown workflow runs again and the
 * host's snapshot, which settles a waiting page whose end was missed.
 */
export const subscribeControlStreamSync = (
  runtimeKey: string,
  apply: (event: ControlStreamSyncEvent) => void,
  showShareAnswer = showShareAnswerToast,
): (() => void) => subscribeOpenchamberEvents((event) => {
  if (runtimeKey !== getRuntimeKey()) return;
  if (event.type === 'notification') {
    // Every client runs this stream, whatever carries its main events, so an
    // answer to a shared page toasts from here alone.
    const shareAnswer = shareAnswerToastFor(event.payload);
    if (shareAnswer) showShareAnswer(shareAnswer);
  } else if (event.type === 'event-stream-ready') {
    useWorkflowRunsStore.getState().reloadLoaded();
    void seedGlobalSessionStatusFromHost().catch(() => undefined);
  } else if (event.type === 'control-sync') {
    apply(event.event);
  }
});
