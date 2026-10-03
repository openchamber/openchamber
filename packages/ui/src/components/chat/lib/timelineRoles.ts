import type { Message } from '@/lib/opencode/model';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import { readSubagentRun } from '@/lib/opencode/subagent-run';

/** Roles `TimelineNotice` owns; the rest belong to `ChatMessage` or nothing. */
const NOTICE_ROLES = new Set<Message['role']>(['compaction', 'shell']);

/**
 * Roles the timeline never shows.
 *
 * `synthetic` is prompt plumbing: the items the user attached in the composer
 * are re-attached to the user message they belong to (see
 * `attachSyntheticContext`), and everything else a plugin injects is machinery
 * the user did not write. The exception is a background report (see
 * `isBackgroundReportEntry`). `system`, `skill` and `location-switched` carry no
 * decision the user has to see. `agent-switched` and `model-switched` say what
 * the composer already shows.
 */
const SKIPPED_ROLES = new Set<Message['role']>([
    'synthetic',
    'system',
    'skill',
    'location-switched',
    'idle',
    'agent-switched',
    'model-switched',
]);

export const isTimelineNoticeRole = (role: Message['role']): boolean => NOTICE_ROLES.has(role);

export const isSkippedTimelineRole = (role: Message['role']): boolean => SKIPPED_ROLES.has(role);

/**
 * A report of work that ran in the background and woke this session: a
 * subagent run (a `subagent: true` command, or a subagent call that went to
 * the background outside the loaded history), or the result of a session the
 * agent dispatched with `returnResult`. It opens a turn of its own, like the
 * prompt a command used to be, so the agent's reaction to the result renders
 * below it. The report of a subagent call the transcript shows is dropped
 * before this point (`keepCommandSubagentReports` in `ChatContainer`) and
 * finishes that call's row instead.
 */
export const isBackgroundReportEntry = (message: Message): boolean =>
    readSubagentRun(message) !== undefined || readDispatchedSessionResult(message) !== undefined;

/** Whether the timeline renders nothing for this message. */
export const isSkippedTimelineMessage = (message: Message): boolean =>
    isSkippedTimelineRole(message.role) && !isBackgroundReportEntry(message);
