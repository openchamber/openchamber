import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SessionProgressSummaryState } from '@/hooks/useSessionProgressSummary';

interface SessionProgressSummaryProps {
    state: SessionProgressSummaryState;
}

/**
 * A temporary progress card for the active turn. It is live UI rather than a
 * persisted message: each update replaces the previous one without adding
 * synthetic history to the transcript.
 */
export const SessionProgressSummary: React.FC<SessionProgressSummaryProps> = React.memo(({ state }) => {
    const { t } = useI18n();
    const { isActive, summary, commandSummary, isGenerating, isCommandGenerating } = state;
    const isGeneratingAnySummary = isGenerating || isCommandGenerating;

    if (!isActive) return null;

    return (
        <div
            className="chat-message-column mt-2 mb-3"
            role="status"
            aria-live="polite"
            aria-label={t('chat.progressSummary.aria')}
        >
            <div className="flex w-full min-w-0 items-start gap-2 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2 text-left">
                <Icon name="pulse" className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="typography-meta font-medium text-foreground">
                            {t('chat.progressSummary.label')}
                        </span>
                        {isGeneratingAnySummary ? <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" /> : null}
                    </div>
                    {commandSummary ? (
                        <p className="mt-0.5 line-clamp-1 typography-meta text-muted-foreground">{commandSummary}</p>
                    ) : null}
                    {summary ? (
                        <p className={`mt-0.5 ${commandSummary ? 'line-clamp-1' : 'line-clamp-2'} typography-meta text-muted-foreground`}>
                            {summary}
                        </p>
                    ) : !commandSummary ? (
                        <p className="mt-0.5 line-clamp-2 typography-meta text-muted-foreground">
                            {t('chat.progressSummary.generating')}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    );
});

SessionProgressSummary.displayName = 'SessionProgressSummary';
