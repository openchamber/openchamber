/**
 * Timeline rows for the message roles that are not a conversation turn.
 *
 * OpenCode v2 promoted things that used to hide inside a user message — a
 * compaction, a shell command, injected context — to message roles of their
 * own. Only `user` and `assistant` carry parts, so the roles that have
 * something to show render here as small, self-contained rows instead of
 * going through `ChatMessage`.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useI18n } from '@/lib/i18n';
import type { Message } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

const SHELL_CODE_STYLE: React.CSSProperties = {
    background: 'transparent',
    padding: 0,
    margin: 0,
};

/** The shared frame every notice row sits in, so they line up with messages. */
const NoticeRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="w-full pb-2">
        <div className="chat-column">{children}</div>
    </div>
);

const CompactionNotice: React.FC<{ message: Extract<Message, { role: 'compaction' }> }> = ({ message }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);

    const label = message.status === 'running'
        ? t('chat.compaction.running')
        : message.status === 'failed'
            ? t('chat.compaction.failed')
            : t('chat.compaction.completed');

    const summary = message.summary.trim();
    // The summary streams in while the compaction runs, so it is shown as it
    // grows; once settled it collapses behind the toggle.
    const showSummary = summary && (expanded || message.status === 'running');

    return (
        <NoticeRow>
            <div className="my-1 rounded-lg border border-border/30 bg-muted/10 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                    {message.status === 'running' ? (
                        <Icon name="loader-4" className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                        <Icon
                            name={message.status === 'failed' ? 'error-warning' : 'archive'}
                            className={cn(
                                'h-3 w-3 shrink-0',
                                message.status === 'failed' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
                            )}
                        />
                    )}
                    <span className="typography-micro text-muted-foreground">{label}</span>
                    {summary && message.status !== 'running' ? (
                        <button
                            type="button"
                            className="ml-auto typography-micro text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? t('chat.compaction.hideSummary') : t('chat.compaction.showSummary')}
                        </button>
                    ) : null}
                </div>
                {message.error ? (
                    <div className="mt-1 typography-micro text-[var(--status-error)] break-words">{message.error.message}</div>
                ) : null}
                {showSummary ? (
                    <div className="mt-1.5 max-h-56 overflow-auto typography-meta text-foreground/85 whitespace-pre-wrap break-words">
                        {summary}
                    </div>
                ) : null}
            </div>
        </NoticeRow>
    );
};

const ShellNotice: React.FC<{ message: Extract<Message, { role: 'shell' }> }> = ({ message }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const output = message.output?.output ?? '';
    const hasOutput = output.trim().length > 0;
    const failed = message.status === 'killed' || message.status === 'timeout' || (message.exit !== undefined && message.exit !== 0);

    return (
        <NoticeRow>
            <div className="my-1 rounded-lg border border-border/30 bg-muted/10 px-2 py-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="typography-meta font-semibold text-foreground">
                        {t('chat.messageBody.shellCommand.title')}
                    </span>
                    <span
                        className={cn(
                            'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
                            failed
                                ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
                                : 'bg-foreground/5 text-muted-foreground',
                        )}
                    >
                        {message.status}
                        {message.exit !== undefined ? ` (${message.exit})` : ''}
                    </span>
                </div>

                <div className="typography-meta mt-1.5 overflow-x-auto font-mono">
                    <WorkerHighlightedCode language="bash" code={message.command} codeStyle={SHELL_CODE_STYLE} wrap />
                </div>

                {hasOutput ? (
                    <div className="mt-2 border-t border-border/60 pt-1.5">
                        <button
                            type="button"
                            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded
                                ? t('chat.messageBody.shellCommand.hideOutput')
                                : t('chat.messageBody.shellCommand.showOutput')}
                        </button>
                        {expanded ? (
                            <div className="typography-meta mt-1.5 max-h-56 overflow-auto font-mono text-foreground/85">
                                <WorkerHighlightedCode language="bash" code={output} codeStyle={SHELL_CODE_STYLE} wrap />
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </NoticeRow>
    );
};

/**
 * The timeline row for a message, or `null` when the caller should render the
 * message itself.
 */
export const TimelineNotice: React.FC<{ message: Message }> = ({ message }) => {
    switch (message.role) {
        case 'compaction':
            return <CompactionNotice message={message} />;
        case 'shell':
            return <ShellNotice message={message} />;
        default:
            return null;
    }
};
