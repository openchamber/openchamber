import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

import { formatThinkingDuration, type SessionThinkingSummary } from '../lib/sessionThinkingSummary';

interface SessionThinkingBlockProps {
    summary: SessionThinkingSummary;
    collapsed: boolean;
    onToggle: () => void;
}

/**
 * Session-level "Thinking" block shown once a session goes idle: it collapses
 * the completed working turns that preceded the latest one into a single row
 * with the wall-clock span, and expands back into the full per-turn view when
 * clicked.
 */
export const SessionThinkingBlock: React.FC<SessionThinkingBlockProps> = React.memo(({ summary, collapsed, onToggle }) => {
    const { t } = useI18n();

    const meta = React.useMemo(() => {
        const parts: string[] = [
            summary.collapsedTurnCount === 1
                ? t('chat.thinkingBlock.turn', { count: summary.collapsedTurnCount })
                : t('chat.thinkingBlock.turns', { count: summary.collapsedTurnCount }),
        ];
        const duration = formatThinkingDuration(summary);
        if (duration) {
            parts.push(duration);
        }
        return parts.join(' · ');
    }, [summary, t]);

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('chat.thinkingBlock.expandAria') : t('chat.thinkingBlock.collapseAria')}
            className="group flex w-full items-center gap-2 rounded-lg border border-border/60 bg-[var(--surface-muted)] px-3 py-2 text-left transition-colors hover:bg-interactive-hover"
        >
            <Icon name="brain" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="typography-ui-label font-medium text-foreground">
                {collapsed ? t('chat.thinkingBlock.label') : t('chat.thinkingBlock.collapseLabel')}
            </span>
            {meta ? (
                <span className="typography-meta text-muted-foreground">{meta}</span>
            ) : null}
            <Icon
                name={collapsed ? 'arrow-right' : 'arrow-down'}
                className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
        </button>
    );
});

SessionThinkingBlock.displayName = 'SessionThinkingBlock';
