import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { applyChatRoute } from '@/lib/routing/chatRoute';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { useConfigStore } from '@/stores/useConfigStore';
import { useModelAttributionFor } from '../context/useModelAttributionFor';

interface ModelChangeDividerProps {
    /** The previous turn's real model, already compact (`provider/model#variant`). */
    from: string;
    /** This turn's real model, already compact. */
    to: string;
    /** This turn's first assistant message, to look up why it changed (round-robin, sticky, failover). */
    assistantMessageId?: string;
}

/**
 * Marks a turn whose real model differs from the one before it — a pool's
 * round-robin pick, a failover, or the user switching model/variant. The
 * reason shows only when the session-scoped routing lookup knows one; a
 * change with no known reason still gets the marker, just without it.
 *
 * The text wraps instead of truncating, so both full model references stay
 * readable at any width. While a pool is selected, "Prefer previous" sends
 * `prefer <from>` through the same interpreter as `/route`, which stores a
 * prefer override that OpenCode applies to every pool's weights.
 */
const ModelChangeDivider: React.FC<ModelChangeDividerProps> = ({ from, to, assistantMessageId }) => {
    const { t } = useI18n();
    const isVSCode = useIsVSCodeRuntime();
    const attribution = useModelAttributionFor(assistantMessageId);
    const poolSelected = useConfigStore((state) => state.currentProviderId === MODEL_ROUTE_PROVIDER_ID);
    const [steering, setSteering] = React.useState(false);
    const reason = attribution?.failover
        ? (attribution.failover.errorMessage || attribution.failover.errorTag || undefined)
        : (attribution?.selection?.reason ?? undefined);
    const text = reason
        ? t('chat.messageBody.modelChanged.noticeWithReason', { from, to, reason })
        : t('chat.messageBody.modelChanged.notice', { from, to });
    // Overrides scope a model, not its thinking variant.
    const previousModel = from.split('#')[0];

    const preferPrevious = async () => {
        setSteering(true);
        try {
            const outcome = await applyChatRoute(`prefer ${previousModel}`, useConfigStore.getState().providers);
            if (outcome.status === 'applied') {
                toast.success(t('chat.chatInput.toast.routeApplied', { summary: outcome.summary }));
            } else if (outcome.status === 'needs-choice') {
                toast.info(t('chat.chatInput.toast.routeNeedsChoice'));
            } else {
                toast.error(t('chat.chatInput.toast.routeUnknown', { reason: outcome.reason }));
            }
        } catch {
            toast.error(t('chat.chatInput.toast.routeFailed'));
        } finally {
            setSteering(false);
        }
    };

    return (
        <div
            className="my-2 flex items-center gap-2 px-1 text-xs text-muted-foreground"
            data-model-changed-divider="true"
        >
            <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden="true" />
            <span className="min-w-0 select-text whitespace-normal text-center font-mono [overflow-wrap:anywhere]" title={text} dir="auto">
                {text}
            </span>
            {poolSelected && !isVSCode ? (
                <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => void preferPrevious()}
                    disabled={steering}
                    title={t('chat.messageBody.modelChanged.preferPreviousTitle', { model: previousModel })}
                    data-model-changed-prefer="true"
                >
                    {t('chat.messageBody.modelChanged.preferPrevious')}
                </Button>
            ) : null}
            <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden="true" />
        </div>
    );
};

export default React.memo(ModelChangeDivider);
