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
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';

export interface AgentSelectorProps {
  /** Currently selected agent name (empty string for no agent) */
  value: string;
  /** Called when agent selection changes */
  onChange: (agentName: string) => void;
  /** Optional className for the trigger */
  className?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** ID for accessibility */
  id?: string;
  /** Portal menu to body instead of nearest dialog. */
  portalToBody?: boolean;
}

/**
 * Agent selector dropdown for selecting an agent for multi-run sessions.
 * Uses getVisibleAgents from useConfigStore to show available agents.
 */
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
    () => agents.filter((agent) => agent.mode !== 'subagent'),
    [agents]
  );

  // Load agents on mount
  React.useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Ensure we always have a valid selection (defaults to current default agent, then first selectable agent).
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

  return (
    <Select
      value={selectValue}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size="lg"
        className={cn(
          'max-w-full typography-meta text-foreground !border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70 data-[popup-open]:!bg-[var(--interactive-active)]/70',
          className,
        )}
      >
        <SelectValue placeholder={t('multirun.agentSelector.placeholder')} />
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
                {agent.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
};
