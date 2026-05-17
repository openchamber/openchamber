import React from 'react';
import type { Agent } from '@opencode-ai/sdk/v2';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentsStore, filterVisibleAgents } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';

interface AgentSelectorProps {
    agentName: string;
    onChange: (agentName: string) => void;
    className?: string;
    filter?: (agent: Agent) => boolean;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
    agentName,
    onChange,
    className,
    filter,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const configAgents = useConfigStore((state) => state.agents);
    const agentsStoreAgents = useAgentsStore((state) => state.agents);
    const loadAgentsStore = useAgentsStore((state) => state.loadAgents);
    const loadConfigAgents = useConfigStore((state) => state.loadAgents);
    const rawAgents = React.useMemo(() => {
        if (Array.isArray(configAgents) && configAgents.length > 0) return configAgents;
        return Array.isArray(agentsStoreAgents) ? agentsStoreAgents : [];
    }, [configAgents, agentsStoreAgents]);
    const agents = React.useMemo(() => {
        const visible = filterVisibleAgents(rawAgents);
        return filter ? visible.filter(filter) : visible;
    }, [rawAgents, filter]);
    const isMobile = useUIStore(state => state.isMobile);
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);

    React.useEffect(() => {
        if (rawAgents.length > 0) return;
        void loadConfigAgents();
        void loadAgentsStore();
    }, [rawAgents.length, loadConfigAgents, loadAgentsStore]);

    const closeMobilePanel = () => setIsMobilePanelOpen(false);

    const handleAgentChange = (newAgentName: string) => {
        onChange(newAgentName);
    };

    const renderMobileAgentPanel = () => {
        if (!isActuallyMobile) return null;

        return (
                <MobileOverlayPanel
                    open={isMobilePanelOpen}
                    onClose={closeMobilePanel}
                    title={t('settings.commands.agentSelector.title')}
                >
                <div className="space-y-1">
                    <button
                        type="button"
                        className={cn(
                            'flex w-full items-center justify-between rounded-lg border border-border/40 bg-background/95 px-2 py-1.5 text-left',
                            !agentName ? 'bg-primary/10 text-primary' : 'text-foreground'
                        )}
                        onClick={() => {
                            handleAgentChange('');
                            closeMobilePanel();
                        }}
                    >
                        <span className={cn('typography-meta', !agentName ? 'font-medium' : 'text-muted-foreground')}>
                            {t('settings.commands.agentSelector.notSelected')}
                        </span>
                        {!agentName && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </button>
                    {agents.map((agent) => {
                        const isSelected = agent.name === agentName;

                        return (
                            <button
                                key={agent.name}
                                type="button"
                                className={cn(
                                    'flex w-full items-center justify-between rounded-lg border border-border/40 bg-background/95 px-2 py-1.5 text-left',
                                    isSelected ? 'bg-primary/10 text-primary' : 'text-foreground'
                                )}
                                onClick={() => {
                                    handleAgentChange(agent.name);
                                    closeMobilePanel();
                                }}
                            >
                                <div className="flex flex-col">
                                    <span className="typography-meta font-medium">{agent.name}</span>
                                    {agent.description && (
                                        <span className="typography-micro text-muted-foreground">
                                            {agent.description}
                                        </span>
                                    )}
                                </div>
                                {isSelected && (
                                    <div className="h-2 w-2 rounded-full bg-primary" />
                                )}
                            </button>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    return (
        <>
            {isActuallyMobile ? (
                <button
                    type="button"
                    onClick={isReady ? () => setIsMobilePanelOpen(true) : undefined}
                    disabled={!isReady}
                    className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/95 px-2 py-1.5 text-left',
                        !isReady && 'opacity-60 cursor-not-allowed',
                        className
                    )}
                >
                    <div className="flex items-center gap-2">
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : (
                            <>
                                <Icon name="robot-2" className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="typography-meta font-medium text-foreground">
                                    {agentName || t('settings.commands.agentSelector.selectAgentPlaceholder')}
                                </span>
                            </>
                        )}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 text-muted-foreground" />
                </button>
            ) : !isReady ? (
                <div className={cn(
                    'flex items-center gap-2 px-2 rounded-lg bg-interactive-selection/20 border border-border/20 h-6 w-fit opacity-60',
                    className
                )}>
                    <Icon name="loader-4" className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />
                    <span className="typography-micro font-medium whitespace-nowrap text-muted-foreground">
                        {isUnavailable ? t('common.unavailable') : t('common.loading')}
                    </span>
                </div>
            ) : (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div className={cn(
                            'flex items-center gap-2 px-2 rounded-lg bg-interactive-selection/20 border border-border/20 cursor-pointer hover:bg-interactive-hover/30 h-6 w-fit',
                            className
                        )}>
                            <Icon name="robot-2" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                            <span className="typography-micro font-medium whitespace-nowrap">
                                {agentName || t('settings.commands.agentSelector.notSelected')}
                            </span>
                            <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-w-[300px]">
                        <DropdownMenuItem
                            className="typography-meta"
                            onSelect={() => handleAgentChange('')}
                        >
                            <span className="text-muted-foreground">{t('settings.commands.agentSelector.notSelected')}</span>
                        </DropdownMenuItem>
                        {agents.map((agent) => (
                            <DropdownMenuItem
                                key={agent.name}
                                className="typography-meta"
                                onSelect={() => handleAgentChange(agent.name)}
                            >
                                <span className="font-medium">{agent.name}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {renderMobileAgentPanel()}
        </>
    );
};
