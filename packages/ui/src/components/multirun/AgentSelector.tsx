import React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { agentLabel } from '@/lib/agentLabel';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';

interface AgentSelectorProps {
  value: string;
  onChange: (agentName: string) => void;
  className?: string;
  disabled?: boolean;
  id?: string;
  portalToBody?: boolean;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  value,
  onChange,
  className,
  disabled,
  id,
  portalToBody,
}) => {
  const { t } = useI18n();
  const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const defaultAgentName = useConfigStore((state) => state.currentAgentName);
  const agents = getVisibleAgents();
  const selectableAgents = React.useMemo(
    () => agents.filter((agent) => isPrimaryMode(agent.mode)),
    [agents]
  );

  React.useEffect(() => {
    if (agents.length === 0) void loadAgents();
  }, [agents.length, loadAgents]);

  React.useEffect(() => {
    if (disabled) {
      return;
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length > 0 && selectableAgents.some((agent) => agent.name === trimmedValue)) {
      return;
    }

    const candidateDefault =
      typeof defaultAgentName === 'string' && defaultAgentName.trim().length > 0
        ? defaultAgentName.trim()
        : null;

    if (candidateDefault && selectableAgents.some((agent) => agent.name === candidateDefault)) {
      onChange(candidateDefault);
      return;
    }

    const firstAgent = selectableAgents[0]?.name;
    if (firstAgent) {
      onChange(firstAgent);
    }
  }, [defaultAgentName, disabled, onChange, selectableAgents, value]);

  const selectValue = value.trim().length > 0 ? value : undefined;
  const selectedAgent = selectableAgents.find((agent) => agent.name === selectValue);

  return (
    <Select
      value={selectValue}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn('max-w-full', className)}
      >
        <SelectValue placeholder={t('multirun.agentSelector.placeholder')}>
          {selectedAgent ? agentLabel(selectedAgent) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent fitContent portalToBody={portalToBody}>
        {selectableAgents.length > 0 && (
          <SelectGroup>
            {selectableAgents.map((agent) => (
              <SelectItem
                key={agent.name}
                value={agent.name}
                className="w-auto whitespace-nowrap"
              >
                {agentLabel(agent)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
};
