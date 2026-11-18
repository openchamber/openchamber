import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { cn } from '@/lib/utils';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { useChatColumnActions } from '@/components/chat/chatColumnSession';

export const OpenSubtaskButton: React.FC<{
    sessionId: string;
    agent: string | undefined;
    isMobile: boolean;
}> = ({ sessionId, agent, isMobile }) => {
    const { t } = useI18n();
    const currentDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const column = useChatColumnActions();
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const runtime = React.useContext(RuntimeAPIContext);

    const agentType = agent ?? 'subagent';
    const agentLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);
    const label = t('chat.toolPart.openSubtask', { type: agentLabel });

    const handleOpen = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (!currentDirectory) return;
        if (column.pinned) {
            column.openSession(sessionId, currentDirectory);
            return;
        }
        if (isMobile || runtime?.runtime.isVSCode) {
            setCurrentSession(sessionId, currentDirectory);
            return;
        }
        openContextPanelTab(currentDirectory, {
            mode: 'chat',
            dedupeKey: `session:${sessionId}`,
            label: agentLabel,
            readOnly: true,
        });
    };

    return (
        <HoverTooltip label={label}>
            <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleOpen}
                className={cn(
                    'flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity',
                    'opacity-60 hover:opacity-100 focus-visible:opacity-100',
                )}
                style={{ color: 'var(--tools-icon)' }}
                aria-label={label}
            >
                <Icon name="external-link" className="h-3 w-3" />
            </button>
        </HoverTooltip>
    );
};
