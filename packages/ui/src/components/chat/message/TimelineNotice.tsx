/**
 * Timeline rows for the message roles that are not a conversation turn.
 *
 * OpenCode v2 promoted things that used to hide inside a user message — a
 * compaction, a shell command, injected context — to message roles of their
 * own. Only `user` and `assistant` carry parts, so the roles that have
 * something to show render here as small, self-contained rows instead of
 * going through `ChatMessage`. So does a background subagent run, which v2
 * reports as a synthetic message (see `@/lib/opencode/subagent-run`).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReasoningTimelineBlock } from './parts/ReasoningPart';
import ToolPart from './parts/ToolPart';
import { OPENCODE_TOOLS } from '@/lib/opencode/tools';
import { isRunningSubagentRunMessage, readSubagentRun, type SubagentRun } from '@/lib/opencode/subagent-run';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';
import type { Message, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

/** The shared frame every notice row sits in, so they line up with messages. */
const NoticeRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="w-full pb-2">
        <div className="chat-column">{children}</div>
    </div>
);

const CompactionNotice: React.FC<{ message: Extract<Message, { role: 'compaction' }> }> = ({ message }) => {
    const { t } = useI18n();
    const running = message.status === 'running';
    const failed = message.status === 'failed';
    const summary = message.summary.trim();

    // A compaction reads like a thinking row: one collapsible tool-style line
    // whose body is the summary as Markdown. The summary streams in while the
    // compaction runs, so the body is open and follows its end until it settles.
    return (
        <NoticeRow>
            <ReasoningTimelineBlock
                text={summary}
                variant="thinking"
                blockId={message.id}
                isStreaming={running}
                presentation={{
                    icon: failed ? 'error-warning' : 'scissors',
                    iconClassName: failed ? 'text-[var(--status-error)]' : undefined,
                    title: running
                        ? t('chat.compaction.running')
                        : failed
                            ? t('chat.compaction.failed')
                            : t('chat.compaction.completed'),
                    expandLabel: t('chat.compaction.showSummary'),
                    collapseLabel: t('chat.compaction.hideSummary'),
                    markdownVariant: 'assistant',
                    maxHeightClassName: 'max-h-[60vh]',
                }}
            />
            {!running && !summary ? (
                <div className="flex items-center gap-1.5 py-1.5 pl-px typography-meta" style={{ color: 'var(--tools-title)' }}>
                    <Icon
                        name={failed ? 'error-warning' : 'scissors'}
                        className={cn('h-3.5 w-3.5 shrink-0', failed && 'text-[var(--status-error)]')}
                        style={failed ? undefined : { color: 'var(--tools-icon)' }}
                    />
                    <span className="font-medium">{failed ? t('chat.compaction.failed') : t('chat.compaction.completed')}</span>
                </div>
            ) : null}
            {message.error ? (
                <div className="pl-5 typography-meta text-[var(--status-error)] break-words">{message.error.message}</div>
            ) : null}
        </NoticeRow>
    );
};

/**
 * A `!command` run is shown as the shell tool the agent would have called, so
 * both read the same: the tool row renders it from a synthesized tool part.
 */
const toShellToolPart = (message: Extract<Message, { role: 'shell' }>): ToolPartType => {
    const input = { command: message.command };
    const start = message.time.created;
    const end = message.time.completed ?? start;
    const output = message.output?.output ?? '';
    // A command killed by a signal ends as "exited" with no exit code; the signal is what marks it failed.
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
        return { ...base, state: { status: 'running', input, metadata: { output }, time: { start } } };
    }
    if (failed) {
        const detail = message.signal ?? message.exit;
        const reason = detail !== undefined ? `${message.status} (${detail})` : message.status;
        return { ...base, state: { status: 'error', input, error: reason, output, time: { start, end } } };
    }
    return { ...base, state: { status: 'completed', input, output, time: { start, end } } };
};

const ShellNotice: React.FC<{ message: Extract<Message, { role: 'shell' }> }> = ({ message }) => {
    const isMobile = useUIStore((state) => state.isMobile);
    const [expanded, setExpanded] = React.useState(false);
    const part = React.useMemo(() => toShellToolPart(message), [message]);
    const toggle = React.useCallback(() => setExpanded((value) => !value), []);

    return (
        <NoticeRow>
            <ToolPart part={part} isExpanded={expanded} onToggle={toggle} isMobile={isMobile} />
        </NoticeRow>
    );
};

type SyntheticMessage = Extract<Message, { role: 'synthetic' }>;

/**
 * A background subagent run is shown as the subagent tool call it stands in
 * for, so it reads like one and opens its child session the same way.
 */
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

/**
 * Revert and fork, cut at this run the way the user message actions cut at a
 * prompt. A run still in progress has no message to cut at yet.
 */
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
    // The child session starts when the run does; the report lands when it ends.
    const startedAt = child?.time.created ?? message.time.created;
    const part = React.useMemo(() => toSubagentToolPart(message, run, startedAt), [message, run, startedAt]);
    const toggle = React.useCallback(() => setExpanded((value) => !value), []);
    // Same rules as the prompt's own actions: none in peek, no fork in mini chat.
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

const SubagentNotice: React.FC<{ message: SyntheticMessage }> = ({ message }) => {
    const run = React.useMemo(() => readSubagentRun(message), [message]);
    return run ? <SubagentRunNotice message={message} run={run} /> : null;
};

/**
 * The timeline row for a message, or `null` when the caller should render the
 * message itself.
 */
export const TimelineNotice: React.FC<{ message: Message }> = ({ message }) => {
    switch (message.role) {
        case 'synthetic':
            return <SubagentNotice message={message} />;
        case 'compaction':
            return <CompactionNotice message={message} />;
        case 'shell':
            return <ShellNotice message={message} />;
        default:
            return null;
    }
};
