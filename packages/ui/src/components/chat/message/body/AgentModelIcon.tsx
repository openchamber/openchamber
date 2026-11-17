import { Icon } from '@/components/icon/Icon';
import { useAgentColors } from '@/hooks/useAgentColors';

export function AgentModelIcon({ agentName }: { agentName: string | undefined }) {
    const getAgentColor = useAgentColors();
    return <Icon name="brain-ai-3" className="h-[13px] w-[13px] flex-shrink-0" style={{ color: getAgentColor(agentName).color }} />;
}
