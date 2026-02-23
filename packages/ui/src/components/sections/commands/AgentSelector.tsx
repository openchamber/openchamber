import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { RiArrowDownSLine, RiRobot2Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';

interface AgentSelectorProps {
    agentName: string;
    onChange: (agentName: string) => void;
    className?: string;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
    agentName,
    onChange,
    className
}) => {
    const { loadAgents, getVisibleAgents } = useAgentsStore();
    const agents = getVisibleAgents();
    const isMobile = useUIStore(state => state.isMobile);
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);

    React.useEffect(() => {
        loadAgents();
    }, [loadAgents]);

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
                title="Select agent"
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
                        <span className={cn('typography-meta', !agentName ? 'font-medium' : 'text-muted-foreground')}>Not selected</span>
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
                    onClick={() => setIsMobilePanelOpen(true)}
                    className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/95 px-2 py-1.5 text-left',
                        className
                    )}
                >
                    <div className="flex items-center gap-2">
                        <RiRobot2Line className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="typography-meta font-medium text-foreground">
                            {agentName || 'Select agent...'}
                        </span>
                    </div>
                    <RiArrowDownSLine className="h-3 w-3 text-muted-foreground" />
                </button>
            ) : (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div className={cn(
                            'flex items-center gap-2 px-2 rounded-lg bg-interactive-selection/20 border border-border/20 cursor-pointer hover:bg-interactive-hover/30 h-6 w-fit',
                            className
                        )}>
                            <RiRobot2Line className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                            <span className="typography-micro font-medium whitespace-nowrap">
                                {agentName || 'Not selected'}
                            </span>
                            <RiArrowDownSLine className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-w-[300px]">
                        <DropdownMenuItem
                            className="typography-meta"
                            onSelect={() => handleAgentChange('')}
                        >
                            <span className="text-muted-foreground">Not selected</span>
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
