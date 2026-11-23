
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReasoningTimelineBlock } from './parts/ReasoningPart';
import ToolPart from './parts/ToolPart';
import { QuietAction } from './parts/ToolResultParts';
import { getLastOutputLine } from './parts/toolOutput';
import { OPENCODE_TOOLS } from '@/lib/opencode/tools';
import { isRunningSubagentRunMessage, readSubagentRun, type SubagentRun } from '@/lib/opencode/subagent-run';
import { readDispatchedSessionResult, type DispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import { readWorkflowReport, type WorkflowReport } from '@/lib/workflows/report';
import { readShareAnswer, type ShareAnswer } from '@/lib/share-pages/answer';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { SessionNoticeBlock } from './SessionNoticeBlock';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import type { IconName } from '@/components/icon/icons';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import type { Message, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

const NoticeRow: React.FC<{ children: React.ReactNode; spacingClassName?: string }> = ({ children, spacingClassName = 'pb-2' }) => (
    <div className={cn('w-full', spacingClassName)}>
        <div className="chat-message-column">{children}</div>
    </div>
);

const CompactionNotice: React.FC<{ message: Extract<Message, { role: 'compaction' }> }> = ({ message }) => {
    const { t } = useI18n();
    const expandWhileStreaming = useUIStore((state) => state.expandReasoningWhileStreaming);
    const running = message.status === 'running';
    const failed = message.status === 'failed';
    const summary = message.summary.trim();
    const model = message.status === 'completed' && message.model
        ? `${message.model.providerID}/${message.model.id}`
        : undefined;
    const title = (
        <>
            {running ? t('chat.compaction.running') : failed ? t('chat.compaction.failed') : t('chat.compaction.completed')}
            {model ? <bdi className="font-normal break-all" style={{ color: 'var(--tools-description)' }} title={model}> · {model}</bdi> : null}
        </>
    );

    return (
        <NoticeRow spacingClassName="pt-1">
            <ReasoningTimelineBlock
                text={summary}
                blockId={message.id}
                isStreaming={running}
                expandWhileStreaming={expandWhileStreaming}
                presentation={{
                    icon: failed ? 'error-warning' : 'scissors',
                    iconClassName: failed ? 'text-[var(--status-error)]' : undefined,
                    title,
                    expandLabel: t('chat.compaction.showSummary'),
                    collapseLabel: t('chat.compaction.hideSummary'),
                    markdownVariant: 'assistant',
                    maxHeightClassName: 'max-h-[60vh]',
                }}
            />
            {!running && !summary ? (
                <div className="flex items-center gap-1.5 py-1.5 ps-px typography-meta" style={{ color: 'var(--tools-description)' }}>
                    <Icon
                        name={failed ? 'error-warning' : 'scissors'}
                        className={cn('h-3.5 w-3.5 shrink-0', failed && 'text-[var(--status-error)]')}
                        style={failed ? undefined : { color: 'var(--tools-icon)' }}
                    />
                    <span>{title}</span>
                </div>
            ) : null}
            {message.error ? (
                <div className="ps-5 typography-meta text-[var(--status-error)] break-words">{message.error.message}</div>
            ) : null}
        </NoticeRow>
    );
};

type ShellRow = { part: ToolPartType; failureReason?: string };

const toShellRow = (message: Extract<Message, { role: 'shell' }>): ShellRow => {
    const input = { command: message.command };
    const start = message.time.created;
    const end = message.time.completed ?? start;
    const output = message.output?.output ?? '';
    const failed = message.status === 'killed'
        || message.status === 'timeout'
        || message.signal !== undefined
        || (message.exit !== undefined && message.exit !== 0);
    const base = {
        id: `${message.id}:shell`,
        sessionID: message.sessionID,
        messageID: message.id,
        type: 'tool' as const,
        callID: message.shellID,
        tool: OPENCODE_TOOLS.shell,
    };
    if (message.status === 'running') {
        return { part: { ...base, state: { status: 'running', input, metadata: { output }, time: { start } } } };
    }
    if (failed) {
        const detail = message.signal ?? message.exit;
        const reason = detail !== undefined ? `${message.status} (${detail})` : message.status;
        const lastLineIsReason = message.status === 'exited'
            && message.signal === undefined
            && message.output?.truncated !== true;
        return {
            part: { ...base, state: { status: 'error', input, error: reason, output, time: { start, end } } },
            failureReason: (lastLineIsReason ? getLastOutputLine(output) : undefined) ?? reason,
        };
    }
    return { part: { ...base, state: { status: 'completed', input, output, time: { start, end } } } };
};

const ShellNotice: React.FC<{ message: Extract<Message, { role: 'shell' }>; isFirstRow: boolean }> = ({ message, isFirstRow }) => {
    const isMobile = useUIStore((state) => state.isMobile);
    const [expanded, setExpanded] = React.useState(false);
    const { part, failureReason } = React.useMemo(() => toShellRow(message), [message]);
    const toggle = React.useCallback(() => setExpanded((value) => !value), []);

    return (
        <NoticeRow spacingClassName={cn('pb-2', isFirstRow && (isMobile ? 'pt-2' : 'pt-4'))}>
            <ToolPart part={part} isExpanded={expanded} onToggle={toggle} isMobile={isMobile} failureReason={failureReason} />
        </NoticeRow>
    );
};

type SyntheticMessage = Extract<Message, { role: 'synthetic' }>;

const toSubagentToolPart = (message: SyntheticMessage, run: SubagentRun, startedAt: number): ToolPartType => {
    const input = { agent: run.agent ?? 'subagent', description: run.description ?? '' };
    const metadata = { sessionID: run.childSessionID };
    const end = message.time.created;
    const base = {
        id: `${message.id}:subagent`,
        sessionID: message.sessionID,
        messageID: message.id,
        type: 'tool' as const,
        callID: run.childSessionID,
        tool: OPENCODE_TOOLS.subagent,
    };
    switch (run.state) {
        case 'running':
            return { ...base, state: { status: 'running', input, metadata, time: { start: startedAt } } };
        case 'completed':
            return { ...base, state: { status: 'completed', input, metadata, output: run.output, time: { start: startedAt, end } } };
        case 'error':
        case 'cancelled':
            return { ...base, state: { status: 'error', input, metadata, error: run.output, time: { start: startedAt, end } } };
    }
};

const NOTICE_ACTION_BUTTON_CLASS = 'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring';

const SubagentRunActions: React.FC<{ message: SyntheticMessage; canFork: boolean; alwaysVisible: boolean }> = ({ message, canFork, alwaysVisible }) => {
    const { t } = useI18n();
    const handleRevert = React.useCallback(() => {
        void useSessionUIStore.getState().revertToMessage(message.sessionID, message.id);
    }, [message.id, message.sessionID]);
    const handleFork = React.useCallback(() => {
        void useSessionUIStore.getState().forkFromMessage(message.sessionID, message.id);
    }, [message.id, message.sessionID]);

    return (
        <div
            className={cn(
                'flex items-center justify-end gap-1.5',
                alwaysVisible
                    ? 'opacity-100'
                    : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/subagent-run:pointer-events-auto group-hover/subagent-run:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
            )}
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={NOTICE_ACTION_BUTTON_CLASS}
                        aria-label={t('chat.messageBody.actions.revertAria')}
                        onClick={handleRevert}
                    >
                        <Icon name="arrow-go-back" className="h-3 w-3" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
            </Tooltip>
            {canFork ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={NOTICE_ACTION_BUTTON_CLASS}
                            aria-label={t('chat.messageBody.actions.forkAria')}
                            onClick={handleFork}
                        >
                            <Icon name="git-branch" className="h-3 w-3" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
                </Tooltip>
            ) : null}
        </div>
    );
};

const SubagentRunNotice: React.FC<{ message: SyntheticMessage; run: SubagentRun }> = ({ message, run }) => {
    const isMobile = useUIStore((state) => state.isMobile);
    const chatSurfaceMode = useChatSurfaceMode();
    const [expanded, setExpanded] = React.useState(false);
    const child = useSession(run.childSessionID);
    const startedAt = child?.time.created ?? message.time.created;
    const part = React.useMemo(() => toSubagentToolPart(message, run, startedAt), [message, run, startedAt]);
    const toggle = React.useCallback(() => setExpanded((value) => !value), []);
    const canCut = !isRunningSubagentRunMessage(message.id) && chatSurfaceMode !== 'peek';

    return (
        <NoticeRow>
            <div className="group/subagent-run">
                <ToolPart part={part} isExpanded={expanded} onToggle={toggle} isMobile={isMobile} />
                {canCut ? <SubagentRunActions message={message} canFork={chatSurfaceMode !== 'mini-chat'} alwaysVisible={isMobile} /> : null}
            </div>
        </NoticeRow>
    );
};

const dispatchedSessionTitle = (
    result: DispatchedSessionResult,
    t: ReturnType<typeof useI18n>['t'],
): string => {
    const title = result.title?.trim();
    switch (result.state) {
        case 'completed':
            return title ? t('chat.dispatchedSession.completed', { title }) : t('chat.dispatchedSession.completedUntitled');
        case 'error':
            return title ? t('chat.dispatchedSession.failed', { title }) : t('chat.dispatchedSession.failedUntitled');
        case 'cancelled':
            return title ? t('chat.dispatchedSession.cancelled', { title }) : t('chat.dispatchedSession.cancelledUntitled');
    }
};

const DISPATCHED_SESSION_ICONS: Record<DispatchedSessionResult['state'], IconName> = {
    completed: 'chat-ai-3',
    error: 'error-warning',
    cancelled: 'close-circle',
};

const DispatchedSessionNotice: React.FC<{ message: SyntheticMessage; result: DispatchedSessionResult }> = ({ message, result }) => {
    const { t } = useI18n();
    const handleOpen = React.useCallback(() => {
        void openSessionLink(result.sessionID, null);
    }, [result.sessionID]);

    return (
        <NoticeRow>
            <ReasoningTimelineBlock
                text={result.output}
                blockId={message.id}
                presentation={{
                    icon: DISPATCHED_SESSION_ICONS[result.state],
                    iconClassName: result.state === 'error' ? 'text-[var(--status-error)]' : undefined,
                    title: dispatchedSessionTitle(result, t),
                    expandLabel: t('chat.dispatchedSession.showAnswer'),
                    collapseLabel: t('chat.dispatchedSession.hideAnswer'),
                    markdownVariant: 'assistant',
                    maxHeightClassName: 'max-h-[60vh]',
                }}
                actions={(
                    <HoverTooltip label={t('contextTooltips.chat.dispatchedOpen')}>
                        <QuietAction icon="external-link" label={t('chat.dispatchedSession.open')} onClick={handleOpen} />
                    </HoverTooltip>
                )}
            />
        </NoticeRow>
    );
};

const WORKFLOW_REPORT_ICONS = {
    completed: 'flow-chart',
    failed: 'error-warning',
    stopped: 'stop',
    declined: 'close-circle',
} satisfies Record<WorkflowReport['state'], IconName>;

const WORKFLOW_REPORT_TITLE_KEYS = {
    completed: 'chat.workflow.report.completed',
    failed: 'chat.workflow.report.failed',
    stopped: 'chat.workflow.report.stopped',
    declined: 'chat.workflow.report.declined',
} as const satisfies Record<WorkflowReport['state'], string>;

const WorkflowReportNotice: React.FC<{ message: SyntheticMessage; report: WorkflowReport }> = ({ message, report }) => {
    const { t } = useI18n();
    return (
        <NoticeRow>
            <ReasoningTimelineBlock
                text={report.output}
                blockId={message.id}
                presentation={{
                    icon: WORKFLOW_REPORT_ICONS[report.state],
                    iconClassName: report.state === 'failed' ? 'text-[var(--status-error)]' : undefined,
                    title: t(WORKFLOW_REPORT_TITLE_KEYS[report.state], { name: report.name }),
                    expandLabel: t('chat.workflow.report.show'),
                    collapseLabel: t('chat.workflow.report.hide'),
                    markdownVariant: 'assistant',
                    maxHeightClassName: 'max-h-[60vh]',
                }}
            />
        </NoticeRow>
    );
};

const ShareAnswerNotice: React.FC<{ message: SyntheticMessage; answer: ShareAnswer }> = ({ message, answer }) => {
    const { t } = useI18n();
    const summary = answer.summary?.replace(/\s+/g, ' ') ?? answer.title.trim();
    return (
        <NoticeRow>
            <ReasoningTimelineBlock
                text={answer.output}
                blockId={message.id}
                presentation={{
                    icon: 'survey',
                    title: summary
                        ? t('chat.sharePage.answer.title', { label: answer.label, summary })
                        : t('chat.sharePage.answer.titleUntitled', { label: answer.label }),
                    expandLabel: t('chat.sharePage.answer.show'),
                    collapseLabel: t('chat.sharePage.answer.hide'),
                    markdownVariant: 'assistant',
                    maxHeightClassName: 'max-h-[60vh]',
                }}
            />
        </NoticeRow>
    );
};

const SubagentNotice: React.FC<{ message: SyntheticMessage }> = ({ message }) => {
    const run = React.useMemo(() => readSubagentRun(message), [message]);
    const dispatched = React.useMemo(() => (run ? undefined : readDispatchedSessionResult(message)), [message, run]);
    const workflow = React.useMemo(() => (run || dispatched ? undefined : readWorkflowReport(message)), [dispatched, message, run]);
    const shareAnswer = React.useMemo(() => (run || dispatched || workflow ? undefined : readShareAnswer(message)), [dispatched, message, run, workflow]);
    if (run) return <SubagentRunNotice message={message} run={run} />;
    if (dispatched) return <DispatchedSessionNotice message={message} result={dispatched} />;
    if (workflow) return <WorkflowReportNotice message={message} report={workflow} />;
    return shareAnswer ? <ShareAnswerNotice message={message} answer={shareAnswer} /> : null;
};

export const TimelineNotice: React.FC<{ message: Message; isFirstRow?: boolean }> = ({ message, isFirstRow = false }) => {
    const notice = readSessionNotice(message);
    if (notice) {
        return (
            <NoticeRow>
                <SessionNoticeBlock notice={notice} blockId={`notice:${message.id}`} />
            </NoticeRow>
        );
    }
    switch (message.role) {
        case 'synthetic':
            return <SubagentNotice message={message} />;
        case 'compaction':
            return <CompactionNotice message={message} />;
        case 'shell':
            return <ShellNotice message={message} isFirstRow={isFirstRow} />;
        default:
            return null;
    }
};
