import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { getAgentDisplayName } from './mobileControlsUtils';
import { getAgentColor } from '@/lib/agentColors';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className }) => {
    const { currentAgentName, getVisibleAgents } = useConfigStore();
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const sessionAgentName = useSessionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const agentColor = getAgentColor(uiAgentName);

    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLongPressRef = React.useRef(false);

    const handlePointerDown = () => {
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
            className={cn(
                'inline-flex min-w-0 items-center select-none',
                'rounded-lg border border-border/50 px-1.5',
                'typography-micro font-medium',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                'touch-none',
                className
            )}
            style={{
                height: '26px',
                maxHeight: '26px',
                minHeight: '26px',
                color: `var(${agentColor.var})`,
            }}
            title={agentLabel}
        >
            <span className="truncate">{agentLabel}</span>
        </button>
    );
};

export default MobileAgentButton;
