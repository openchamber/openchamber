import type { Message } from '@/lib/opencode/model';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import { readWorkflowReport } from '@/lib/workflows/report';
import { readSubagentRun } from '@/lib/opencode/subagent-run';

/** Roles `TimelineNotice` owns; the rest belong to `ChatMessage` or nothing. */
const NOTICE_ROLES = new Set<Message['role']>(['compaction', 'shell']);

/**
 * Roles the timeline never shows.
 *
 * `synthetic` is prompt plumbing: the items the user attached in the composer
 * are re-attached to the user message they belong to (see
 * `attachSyntheticContext`), and everything else a plugin injects is machinery
 * the user did not write. The exceptions are a background report (see
 * `isBackgroundReportEntry`) and a session notice, a labelled `synthetic`
 * message or OpenCode's `system` note of a move (see
 * `@/lib/opencode/session-notices`), which
 * `attachSyntheticContext` turns into an info row and `MessageRow` draws before
 * this check. Turn splitting still counts a notice as skipped, so a step after
 * an answer opens its turn at it. Other `system` messages, `skill` and
 * `location-switched` carry no decision the user has to see. `agent-switched` and `model-switched` say what
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
    readSubagentRun(message) !== undefined
    || readDispatchedSessionResult(message) !== undefined
    || readWorkflowReport(message) !== undefined;

/**
 * A notice row that opens a turn the way a prompt does: a background report,
 * or a compaction. OpenCode compacts in the middle of a run once the context
 * fills and the agent carries on after it, so the steps that follow belong
 * below the compaction row, not to the turn that was running before it.
 */
export const isTurnOpeningNotice = (message: Message): boolean =>
    message.role === 'compaction' || isBackgroundReportEntry(message);

/** Whether the timeline renders nothing for this message. */
export const isSkippedTimelineMessage = (message: Message): boolean =>
    isSkippedTimelineRole(message.role) && !isBackgroundReportEntry(message);

/**
 * Finds the notices that split a turn. A reply that finished with `stop` is
 * an answer; when only skipped notices separate it from the next assistant
 * message, the last of those notices opens a turn for that message, so each
 * answer renders as its own turn instead of the earlier one landing under
 * the later one's Activity. Steps of one run end with `tool-calls`, so a
 * notice between them leaves the turn whole.
 *
 * Feed it every message in order. For an assistant message it returns the
 * index of the notice that opens a turn for it, or -1.
 */
export const createNoticeTurnSplitter = () => {
    let afterAnswer = false;
    let noticeIndex = -1;
    return (message: Message, index: number): number => {
        if (message.role === 'assistant') {
            const splitAt = noticeIndex;
            afterAnswer = message.finish === 'stop';
            noticeIndex = -1;
            return splitAt;
        }
        if (afterAnswer && isSkippedTimelineMessage(message)) {
            noticeIndex = index;
            return -1;
        }
        afterAnswer = false;
        noticeIndex = -1;
        return -1;
    };
};
