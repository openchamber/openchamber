import React from 'react';
import type { Agent } from '@/lib/opencode/model';
import { agentLabel } from '@/lib/agentLabel';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentsStore, filterVisibleAgents } from '@/stores/useAgentsStore';
import { selectConfigAgentsForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';

interface AgentSelectorProps {
    agentName: string;
    onChange: (agentName: string) => void;
    className?: string;
    filter?: (agent: Agent) => boolean;
    dropdownPortalToBody?: boolean;
    directory?: string;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
    agentName,
    onChange,
    className,
    filter,
    dropdownPortalToBody = false,
    directory,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness('agents', directory);
    const configAgents = useConfigStore((state) => selectConfigAgentsForDirectory(state, directory));
    const agentsStoreAgents = useAgentsStore((state) => state.agents);
    const loadAgentsStore = useAgentsStore((state) => state.loadAgents);
    const loadConfigAgents = useConfigStore((state) => state.loadAgents);
    const rawAgents = React.useMemo(() => {
        if (directory !== undefined) return configAgents;
        if (Array.isArray(configAgents) && configAgents.length > 0) return configAgents;
        return Array.isArray(agentsStoreAgents) ? agentsStoreAgents : [];
    }, [configAgents, agentsStoreAgents, directory]);
    const selectedAgent = rawAgents.find((agent) => agent.name === agentName);
    const selectedAgentLabel = selectedAgent ? agentLabel(selectedAgent) : agentName;
    const agents = React.useMemo(() => {
        const visible = filterVisibleAgents(rawAgents);
        return filter ? visible.filter(filter) : visible;
    }, [rawAgents, filter]);
    const isMobile = useUIStore(state => state.isMobile);
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);

    React.useEffect(() => {
        if (directory !== undefined) {
            void loadConfigAgents({ directory });
            return;
        }
        if (rawAgents.length > 0) return;
        void loadConfigAgents();
        void loadAgentsStore();
    }, [directory, rawAgents.length, loadConfigAgents, loadAgentsStore]);

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
                <MobileSheetRow
                    selected={!agentName}
                    onClick={() => {
                        handleAgentChange('');
                        closeMobilePanel();
                    }}
                >
                    {t('settings.commands.agentSelector.notSelected')}
                </MobileSheetRow>
                {agents.map((agent) => (
                    <MobileSheetRow
                        key={agent.name}
                        selected={agent.name === agentName}
                        onClick={() => {
                            handleAgentChange(agent.name);
                            closeMobilePanel();
                        }}
                    >
                        {agentLabel(agent)}
                    </MobileSheetRow>
                ))}
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
                        dropdownTriggerVariants({ size: 'mobile' }),
                        'w-fit max-w-full',
                        className
                    )}
                >
                    <div className="flex items-center gap-2">
                        {!isReady && !agentName ? (
                            <>
                                {isUnavailable ? <Icon name="error-warning" className="h-3.5 w-3.5 text-muted-foreground" /> : <Spinner className="h-3.5 w-3.5 text-muted-foreground" />}
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : (
                            <>
                                <Icon name="robot-2" className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="typography-meta font-medium text-foreground">
                                    {selectedAgentLabel || t('settings.commands.agentSelector.selectAgentPlaceholder')}
                                </span>
                            </>
                        )}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 text-muted-foreground" />
                </button>
            ) : !isReady ? (
                <div className={cn(
                    dropdownTriggerVariants(),
                    'w-fit opacity-60',
                    className
                )}>
                    {agentName ? (
                        <Icon name="robot-2" className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    ) : isUnavailable ? (
                        <Icon name="error-warning" className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    ) : (
                        <Spinner className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    )}
                    <span className="typography-micro font-medium whitespace-nowrap text-muted-foreground">
                        {agentName || (isUnavailable ? t('common.unavailable') : t('common.loading'))}
                    </span>
                </div>
            ) : (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div className={cn(
                            dropdownTriggerVariants(),
                            'w-fit cursor-pointer',
                            className
                        )}>
                            <Icon name="robot-2" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                            <span className="typography-micro min-w-0 flex-1 truncate text-start font-medium">
                                {agentName || t('settings.commands.agentSelector.notSelected')}
                            </span>
                            <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-w-[300px]" portalToBody={dropdownPortalToBody}>
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
                                <span className="font-medium">{agentLabel(agent)}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {renderMobileAgentPanel()}
        </>
    );
};
