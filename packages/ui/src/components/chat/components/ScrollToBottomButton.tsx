import React from 'react';

import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useBackgroundSessionWork } from '@/hooks/useBackgroundSessionWork';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { BackgroundWorkButton } from './BackgroundWorkButton';
import { registerFloatingPanelClearanceReader } from '@/components/chat/composer/state/composerInsetReaders';

/** The scroll action: the arrow, plus the status label while the session works. */
const ScrollAction: React.FC<{ onClick: () => void; children?: React.ReactNode }> = ({ onClick, children }) => {
    const { t } = useI18n();
    return (
        // Sits inside the pill's hairline border, so the pill as a whole is
        // 28px like the status row it takes over from.
        <button
            type="button"
            onClick={onClick}
            aria-label={t('chat.scrollToBottom.aria')}
            className="inline-flex h-[calc(1.75rem-2px)] min-w-0 max-w-full flex-1 items-center rounded-full [corner-shape:round] text-left"
        >
            {/* flex-1 so the icon stays centred when the mobile
                touch-target floor widens the bare button past 28px;
                with the status label present it collapses back to
                its 28px basis. */}
            <span className="flex h-full w-7 flex-1 shrink-0 basis-7 items-center justify-center text-muted-foreground">
                <Icon name="arrow-down" className="h-4 w-4" />
            </span>
            {children}
        </button>
    );
};

/**
 * Compact one-line mirror of the status row for the pill: same label and
 * background action, none of the status row's animation machinery (which does
 * not survive being squeezed into a 28px chip). The action is a sibling of the
 * scroll button, never inside it.
 */
const WorkingPillBody: React.FC<{ onClick: () => void }> = ({ onClick }) => {
    const { t } = useI18n();
    const { activeModel, working } = useAssistantStatus();
    const providers = useConfigStore((state) => state.providers);
    const backgroundWork = useBackgroundSessionWork();

    const modelName = React.useMemo(() => {
        if (!activeModel) return null;
        const provider = providers.find((candidate) => candidate.id === activeModel.providerId);
        return getProviderModelDisplayName(provider, activeModel.modelId) || null;
    }, [activeModel, providers]);

    if (!working.isWorking || !working.statusText) return <ScrollAction onClick={onClick} />;
    const status = working.statusText;
    const label = modelName && modelName.trim().length > 0
        ? t('chat.statusRow.modelStatus', { model: modelName.trim(), status })
        : status.charAt(0).toUpperCase() + status.slice(1);

    return (
        <>
            <ScrollAction onClick={onClick}>
                <span className={cn('-ml-px min-w-0 truncate text-[13px] leading-4 text-muted-foreground', working.canBackground ? 'pr-1' : 'pr-3')}>
                    {label}
                </span>
            </ScrollAction>
            {working.canBackground ? <BackgroundWorkButton onClick={backgroundWork} className="mr-0.5 h-6 w-6" /> : null}
        </>
    );
};

interface ScrollToBottomButtonProps {
    visible: boolean;
    /** The session is still streaming: the pill carries the status label
        while the floating status row is hidden away from the live edge. */
    working?: boolean;
    onClick: () => void;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, working = false, onClick }) => {
    return (
        <div
            ref={registerFloatingPanelClearanceReader}
            className={cn(
                'pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100',
                visible ? 'opacity-100' : 'opacity-0',
            )}
            style={{ transform: 'translateY(calc(-1 * var(--chat-floating-panel-clearance, 0px)))' }}
        >
            {/* The same column that centres the composer, so the pill's left
                edge lines up exactly with the input frame. */}
            <div className="chat-input-column">
                {/* The soft shadow lives on this wrapper, away from the glass
                    pill's backdrop-filter: sharing one element made the
                    shadow intermittently drop after hide/show cycles. */}
                <div className="inline-flex max-w-full rounded-full shadow-[0_2px_6px_-2px_rgb(0_0_0_/_0.10)] dark:shadow-[0_2px_6px_-2px_rgb(0_0_0_/_0.35)]">
                <div
                    className={cn(
                        // Glass material with a hairline real border — much
                        // lighter than the oc-glass-floating stack.
                        // min-h, not h: the mobile touch-target floor grows
                        // the buttons inside to 36px, and the pill with them.
                        'oc-glass-popover inline-flex min-h-7 max-w-full items-center rounded-full [corner-shape:round]',
                        'border border-black/[0.06] dark:border-white/[0.08]',
                        visible ? 'pointer-events-auto' : 'pointer-events-none',
                    )}
                >
                    {working && visible ? <WorkingPillBody onClick={onClick} /> : <ScrollAction onClick={onClick} />}
                </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(ScrollToBottomButton);
