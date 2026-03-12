import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore, isAgentBuiltIn, type AgentWithExtras } from '@/stores/useAgentsStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface AgentInfo {
  name: string;
  description?: string;
  mode?: string | null;
  scope?: string;
  isBuiltIn?: boolean;
}

export interface AgentMentionAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

type AutocompleteTab = 'commands' | 'agents' | 'files';

const isMentionableAgentMode = (mode?: string | null): boolean => {
  if (!mode) return false;
  return mode !== 'primary';
};

interface AgentMentionAutocompleteProps {
  searchQuery: string;
  onAgentSelect: (agentName: string) => void;
  onClose: () => void;
  showTabs?: boolean;
  activeTab?: AutocompleteTab;
  onTabSelect?: (tab: AutocompleteTab) => void;
}

export const AgentMentionAutocomplete = React.forwardRef<AgentMentionAutocompleteHandle, AgentMentionAutocompleteProps>(({ 
  searchQuery,
  onAgentSelect,
  onClose,
  showTabs,
  activeTab = 'agents',
  onTabSelect,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const ignoreTabClickRef = React.useRef(false);
  const { getVisibleAgents } = useConfigStore();
  const { agents: agentsWithMetadata, loadAgents } = useAgentsStore();

  React.useEffect(() => {
    if (agentsWithMetadata.length === 0) {
      void loadAgents();
    }
  }, [loadAgents, agentsWithMetadata.length]);

  React.useEffect(() => {
    const visibleAgents = getVisibleAgents();
    const filtered = visibleAgents
      .filter((agent) => isMentionableAgentMode(agent.mode))
      .map((agent) => {
        const metadata = agentsWithMetadata.find(a => a.name === agent.name) as (AgentWithExtras & { scope?: string }) | undefined;
        return {
          name: agent.name,
          description: agent.description,
          mode: agent.mode ?? undefined,
          scope: metadata?.scope,
          isBuiltIn: metadata ? isAgentBuiltIn(metadata) : false,
        };
      });

    const normalizedQuery = searchQuery.trim();
    const matches = normalizedQuery.length
      ? filtered.filter((agent) => fuzzyMatch(agent.name, normalizedQuery))
      : filtered;

    matches.sort((a, b) => a.name.localeCompare(b.name));

    setAgents(matches);
    setSelectedIndex(0);
  }, [getVisibleAgents, searchQuery, agentsWithMetadata]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }

      if (!agents.length) {
        return;
      }

      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % agents.length);
        return;
      }

      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + agents.length) % agents.length);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const agent = agents[(selectedIndex + agents.length) % agents.length];
        if (agent) {
          onAgentSelect(agent.name);
        }
      }
    },
  }), [agents, onAgentSelect, onClose, selectedIndex]);

  const renderAgent = (agent: AgentInfo, index: number) => {
    const isSystem = agent.isBuiltIn;
    const isProject = agent.scope === 'project';
    
    return (
      <div
        key={agent.name}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
          className={cn(
            'flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label',
          index === selectedIndex && 'bg-interactive-selection'
          )}
        onClick={() => onAgentSelect(agent.name)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">#{agent.name}</span>
            {isSystem ? (
              <span className="text-[10px] leading-none uppercase font-bold tracking-tight bg-[var(--status-warning-background)] text-[var(--status-warning)] border-[var(--status-warning-border)] px-1.5 py-1 rounded border flex-shrink-0">
                system
              </span>
            ) : agent.scope ? (
              <span className={cn(
                "text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0",
                isProject 
                  ? "bg-[var(--status-info-background)] text-[var(--status-info)] border-[var(--status-info-border)]"
                  : "bg-[var(--status-success-background)] text-[var(--status-success)] border-[var(--status-success-border)]"
              )}>
                {agent.scope}
              </span>
            ) : null}
          </div>
          {agent.description && (
            <div className="typography-meta text-muted-foreground mt-0.5 truncate">
              {agent.description}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[360px] max-h-60 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
    >
      {showTabs ? (
        <div className="px-2 pt-2 pb-1 border-b border-border/60">
          <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-elevated)] p-1">
            {([
              { id: 'commands' as const, label: 'Commands' },
              { id: 'agents' as const, label: 'Agents' },
              { id: 'files' as const, label: 'Files' },
            ]).map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  'flex-1 px-2.5 py-1 rounded-md typography-meta font-semibold transition-none',
                  activeTab === tab.id
                    ? 'bg-interactive-selection text-interactive-selection-foreground shadow-none'
                    : 'text-muted-foreground hover:bg-interactive-hover/50'
                )}
                onPointerDown={(event) => {
                  if (event.pointerType !== 'touch') {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  ignoreTabClickRef.current = true;
                  onTabSelect?.(tab.id);
                }}
                onClick={() => {
                  if (ignoreTabClickRef.current) {
                    ignoreTabClickRef.current = false;
                    return;
                  }
                  onTabSelect?.(tab.id);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {agents.length ? (
          <div>
            {agents.map((agent, index) => renderAgent(agent, index))}
          </div>
        ) : (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            No agents found
          </div>
        )}
      </ScrollableOverlay>
      <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
        ↑↓ navigate • Enter select • Esc close
      </div>
    </div>
  );
});

AgentMentionAutocomplete.displayName = 'AgentMentionAutocomplete';
