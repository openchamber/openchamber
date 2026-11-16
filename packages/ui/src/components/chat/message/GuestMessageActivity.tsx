import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { resolveGuestToolIcon } from '@/lib/guests/icon';
import type { GuestMessagePresentation } from '@/lib/guests/message-presentation';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { TodoListOutput } from './parts/TodoListOutput';
import { parseTodoChecklist } from './parts/todoList';

const TONE_COLOR = {
    neutral: 'var(--tools-icon)',
    info: 'var(--status-info)',
    success: 'var(--status-success)',
    warning: 'var(--status-warning)',
    error: 'var(--status-error)',
} as const satisfies Record<NonNullable<GuestMessagePresentation['rule']['tone']>, string>;

const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

/**
 * A user message an extension claimed through `contributes.messages`: a
 * plugin's notice or directive sent on the user's behalf, drawn as a row of
 * agent activity (same rhythm as a tool row) instead of the user's bubble.
 * Collapsed by default; the body is the message without its markers.
 */
export const GuestMessageActivity: React.FC<{
    messageId: string;
    presentation: GuestMessagePresentation;
}> = ({ messageId, presentation }) => {
    const { rule, title, subtitle, body } = presentation;
    const [expanded, setExpanded] = React.useState(false);
    const canExpand = rule.body !== 'none' && body.length > 0;
    // `todos`: the message lists todos as `- [status] content` lines; draw them
    // like a todo tool's result. A message without such lines falls back to markdown.
    const todos = React.useMemo(() => (rule.body === 'todos' ? parseTodoChecklist(body) : null), [rule.body, body]);
    const guestIcon = resolveGuestToolIcon(rule.guestId, rule.icon, getRuntimeUrlResolver().authenticatedAsset);
    const iconColor = TONE_COLOR[rule.tone ?? 'neutral'];
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';

    const toggle = () => {
        if (canExpand) setExpanded((value) => !value);
    };

    return (
        <div className="w-full pt-1 pb-1" id={`message-${messageId}`} data-message-id={messageId} data-guest-message={rule.guestId}>
            <div className="chat-message-column relative">
                <div
                    className={cn('group/tool flex items-center gap-1.5 rounded-md py-0.5 pe-2', canExpand && 'cursor-pointer')}
                    role={canExpand ? 'button' : undefined}
                    tabIndex={canExpand ? 0 : undefined}
                    aria-expanded={canExpand ? expanded : undefined}
                    onClick={toggle}
                    onKeyDown={(event) => {
                        if (!canExpand || (event.key !== 'Enter' && event.key !== ' ')) return;
                        event.preventDefault();
                        toggle();
                    }}
                >
                    <span className="relative flex h-5 w-3.5 flex-shrink-0 items-center justify-center">
                        <span
                            className={cn('absolute inset-0 flex items-center justify-center transition-opacity', canExpand && (expanded ? 'opacity-0' : 'group-hover/tool:opacity-0'))}
                            style={{ color: iconColor }}
                        >
                            {guestIcon
                                ? <GuestIcon icon={guestIcon.icon} iconSrc={guestIcon.iconSrc} className={iconClass} />
                                : <Icon name="robot-2" className={iconClass} />}
                        </span>
                        {canExpand ? (
                            // Centred in the same box as the icon; a bare absolute icon
                            // sits at the top of the 20px column, above the title.
                            <span className={cn('absolute inset-0 flex items-center justify-center transition-opacity', expanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100')}>
                                <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
                            </span>
                        ) : null}
                    </span>
                    <span className={cn('typography-meta flex-shrink-0 font-medium text-foreground', ROW_TEXT_CLASS)}>{title}</span>
                    {subtitle ? (
                        <span className={cn('typography-meta min-w-0 truncate text-muted-foreground', ROW_TEXT_CLASS)}>{subtitle}</span>
                    ) : null}
                </div>
                {expanded && canExpand ? (
                    <div className="mt-1 mb-2 ms-[7px] border-s border-border/60 ps-4 pe-2">
                        {todos ? (
                            <TodoListOutput todos={todos} />
                        ) : rule.body === 'text' ? (
                            <pre className="typography-code m-0 whitespace-pre-wrap break-words text-muted-foreground">{body}</pre>
                        ) : (
                            <SimpleMarkdownRenderer content={body} variant="tool" />
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
};
