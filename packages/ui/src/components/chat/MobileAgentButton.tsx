import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useChatSessionSelection } from './chatColumnSession';
import { useSelectionStore } from '@/sync/selection-store';
import { getAgentDisplayName } from './mobileControlsUtils';
import { useAgentColors } from '@/hooks/useAgentColors';
import { isAutoModel } from '@/lib/routing/autoModel';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useAgentMissingFromCatalog } from './agentAvailability';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className }) => {
    const getAgentColor = useAgentColors();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const currentSessionId = useChatSessionSelection().sessionId;
    const sessionAgentName = useSelectionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const agentColor = getAgentColor(uiAgentName);
    // The send would stop with an error, so the button says so beforehand.
    const agentUnavailable = useAgentMissingFromCatalog(uiAgentName);
    const { t } = useI18n();
    const unavailableText = agentUnavailable && uiAgentName
        ? t('chat.modelControls.agentUnavailable', { agent: uiAgentName })
        : undefined;

    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLongPressRef = React.useRef(false);

    const handlePointerDown = (event: React.PointerEvent) => {
        // Same pattern as PermissionAutoAcceptButton: block the focus transfer
        // iOS performs on touch so cycling the agent keeps the keyboard open.
        if (event.pointerType === 'touch') {
            event.preventDefault();
        }
        isLongPressRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
            isLongPressRef.current = true;
            onOpenAgentPanel();
        }, LONG_PRESS_MS);
    };

    // Use onPointerUp (not onClick) to prevent focus transfer that closes mobile keyboard
    const handlePointerUp = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (!isLongPressRef.current) {
            onCycleAgent();
        }
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    // Under Auto the routing category names the agent, so the composer offers
    // no agent to pick — same as the desktop controls.
    if (isAutoModel(currentProviderId, currentModelId)) return null;

    return (
        <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp} // Don't use onClick - it closes mobile keyboard
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
                // 36px to tap, drawn in the row's 26px: the margin keeps the row's height.
                'inline-flex h-9 -my-[5px] min-h-0 min-w-0 items-stretch select-none',
                'rounded-lg',
                'typography-micro font-medium',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                'touch-none',
                className
            )}
            style={unavailableText ? undefined : { color: agentColor.color }}
            title={unavailableText ?? agentLabel}
            aria-label={unavailableText}
        >
            <span className={cn('flex h-full w-full min-w-0 items-center', unavailableText && 'gap-1 text-foreground')}>
                {unavailableText ? <Icon name="error-warning" className="size-3.5 flex-shrink-0 text-[var(--status-warning)]" /> : null}
                <span className="truncate">{agentLabel}</span>
            </span>
        </button>
    );
};
