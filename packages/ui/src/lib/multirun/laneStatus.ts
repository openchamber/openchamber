import type { Session } from '@/lib/opencode/model';
import type { I18nKey } from '@/lib/i18n';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import type { LaneReplyState } from './useLaneSummaries';

export const hasRunningGoal = (session: Pick<Session, 'metadata'> | undefined): boolean => (
  getSessionGoal(session)?.status === 'active'
);

export type LaneStatus = 'permission' | 'question' | 'working' | 'failed' | 'stopped' | 'notStarted' | 'noReply' | 'finished';

export type LaneBlockingState = 'permission' | 'question' | null;

export function resolveLaneStatus(input: {
  session: Pick<Session, 'outcome' | 'time' | 'metadata'>;
  busy: boolean;
  blocking: LaneBlockingState;
  reply: LaneReplyState | undefined;
}): LaneStatus {
  if (input.blocking) return input.blocking;
  if (input.busy || hasRunningGoal(input.session)) return 'working';
  if (input.session.outcome === 'failed') return 'failed';
  if (input.session.outcome === 'interrupted') return 'stopped';
  if (!input.session.time.idle) return 'notStarted';
  if (input.reply?.state === 'ready' && !input.reply.text) return 'noReply';
  return 'finished';
}

export const LANE_STATUS_ORDER: readonly LaneStatus[] = ['permission', 'question', 'failed', 'working', 'noReply', 'stopped', 'notStarted', 'finished'];

export const LANE_STATUS_COUNT_KEYS = {
  permission: 'multirun.overview.status.count.permission',
  question: 'multirun.overview.status.count.question',
  working: 'multirun.overview.status.count.working',
  failed: 'multirun.overview.status.count.failed',
  stopped: 'multirun.overview.status.count.stopped',
  notStarted: 'multirun.overview.status.count.notStarted',
  noReply: 'multirun.overview.status.count.noReply',
  finished: 'multirun.overview.status.count.finished',
} satisfies Record<LaneStatus, I18nKey>;

export const LANE_STATUS_LABEL_KEYS = {
  permission: 'multirun.overview.status.permission',
  question: 'multirun.overview.status.question',
  working: 'multirun.overview.status.working',
  failed: 'multirun.overview.status.failed',
  stopped: 'multirun.overview.status.stopped',
  notStarted: 'multirun.overview.status.notStarted',
  noReply: 'multirun.overview.status.noReply',
  finished: 'multirun.overview.status.finished',
} satisfies Record<LaneStatus, I18nKey>;
