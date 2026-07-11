import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getAgentDisplayName } from './mobileControlsUtils';
import { AgentCycleLabel } from '@/components/chat/AgentCycleLabel';
import { useAgentCycleLabelReveal } from '@/components/chat/useAgentCycleLabelReveal';
import { getAgentColor } from '@/lib/agentColors';
import { COMPOSER_ICON_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className }) => {
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionAgentName = useSelectionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const showAgentCycleLabel = useAgentCycleLabelReveal(uiAgentName);
    const agentColor = getAgentColor(uiAgentName);

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

    return (
        <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp} // Don't use onClick - it closes mobile keyboard
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
                'inline-flex flex-shrink-0 items-center select-none focus:outline-none touch-none',
                COMPOSER_ICON_HOVER_CLASS,
                className
            )}
            title={agentLabel}
            aria-label={agentLabel}
        >
            <AgentCycleLabel
                name={uiAgentName}
                label={agentLabel}
                revealed={showAgentCycleLabel}
                avatarSize={16}
                slotClassName="h-6 w-6"
                colorVar={agentColor.var}
            />
        </button>
    );
};
