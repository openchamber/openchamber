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

export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onOpenAgentPanel, onCycleAgent, className }) => {
    const { currentAgentName, getVisibleAgents } = useConfigStore();
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const sessionAgentName = useSessionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );
    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressTriggeredRef = React.useRef(false);

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const agentColor = getAgentColor(uiAgentName);

    const clearLongPressTimer = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const startLongPressTimer = React.useCallback(() => {
        clearLongPressTimer();
        longPressTriggeredRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            onOpenAgentPanel();
        }, LONG_PRESS_MS);
    }, [clearLongPressTimer, onOpenAgentPanel]);

    React.useEffect(() => {
        return () => clearLongPressTimer();
    }, [clearLongPressTimer]);

    return (
        <button
            type="button"
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                startLongPressTimer();
            }}
            onPointerUp={clearLongPressTimer}
            onPointerLeave={clearLongPressTimer}
            onPointerCancel={clearLongPressTimer}
            onClick={(event) => {
                if (longPressTriggeredRef.current) {
                    event.preventDefault();
                    longPressTriggeredRef.current = false;
                    return;
                }
                onCycleAgent();
            }}
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
            <span className="min-w-0 max-w-full overflow-x-auto whitespace-nowrap scrollbar-hidden">
                {agentLabel}
            </span>
        </button>
    );
};

export default MobileAgentButton;
