import type { Session } from '@/lib/opencode/model';
import type { I18nKey } from '@/lib/i18n';
import type { LaneReplyState } from './useLaneSummaries';

/**
 * What a run member is doing, from live and recorded facts only:
 * - `permission` / `question`: a blocking request waits for the user, so the
 *   turn cannot move on (a blocked session also counts as busy, so this wins);
 * - `working`: the turn is live;
 * - `failed` / `stopped`: OpenCode recorded the turn as failed or interrupted;
 * - `notStarted`: no turn has ended and none is running;
 * - `noReply`: the turn ended normally without any answer text;
 * - `finished`: the turn ended normally. It says nothing about quality.
 */
export type LaneStatus = 'permission' | 'question' | 'working' | 'failed' | 'stopped' | 'notStarted' | 'noReply' | 'finished';

export type LaneBlockingState = 'permission' | 'question' | null;

export function resolveLaneStatus(input: {
  session: Pick<Session, 'outcome' | 'time'>;
  busy: boolean;
  blocking: LaneBlockingState;
  reply: LaneReplyState | undefined;
}): LaneStatus {
  if (input.blocking) return input.blocking;
  if (input.busy) return 'working';
  if (input.session.outcome === 'failed') return 'failed';
  if (input.session.outcome === 'interrupted') return 'stopped';
  if (!input.session.time.idle) return 'notStarted';
  if (input.reply?.state === 'ready' && !input.reply.text) return 'noReply';
  return 'finished';
}

/** Order of the overview's status summary: what needs the user comes first. */
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
