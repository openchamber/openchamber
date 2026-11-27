import type { Message } from '@/lib/opencode/model';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import { readWorkflowReport } from '@/lib/workflows/report';
import { readShareAnswer } from '@/lib/share-pages/answer';
import { readShellCompletion } from '@/lib/opencode/background-shell';
import { readSubagentRun } from '@/lib/opencode/subagent-run';

const NOTICE_ROLES = new Set<Message['role']>(['compaction', 'shell']);

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

export const isBackgroundReportEntry = (message: Message): boolean =>
    readSubagentRun(message) !== undefined
    || readDispatchedSessionResult(message) !== undefined
    || readWorkflowReport(message) !== undefined
    || readShareAnswer(message) !== undefined;

export const isTurnOpeningNotice = (message: Message): boolean =>
    message.role === 'compaction' || isBackgroundReportEntry(message);

export const isSkippedTimelineMessage = (message: Message): boolean =>
    isSkippedTimelineRole(message.role) && !isBackgroundReportEntry(message);

export const createNoticeTurnSplitter = () => {
    let afterAnswer = false;
    let noticeIndex = -1;
    let openedByCommand = false;
    return (message: Message, index: number): number => {
        if (message.role === 'assistant') {
            const splitAt = noticeIndex;
            afterAnswer = message.finish === 'stop';
            noticeIndex = -1;
            openedByCommand = false;
            return splitAt;
        }
        if (afterAnswer && isSkippedTimelineMessage(message)) {
            if (!openedByCommand) noticeIndex = index;
            openedByCommand ||= readShellCompletion(message) !== undefined;
            return -1;
        }
        afterAnswer = false;
        noticeIndex = -1;
        openedByCommand = false;
        return -1;
    };
};
