import React, { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { isMobileDeviceViaCSS } from '@/lib/device';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentsStore, isAgentBuiltIn, isAgentHidden, type AgentScope, type AgentDraft } from '@/stores/useAgentsStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import type { Agent } from '@opencode-ai/sdk/v2';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SidebarGroup } from '@/components/sections/shared/SidebarGroup';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

interface AgentsSidebarProps {
  onItemSelect?: () => void;
}

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };

type PermissionConfigValue = PermissionAction | Record<string, PermissionAction>;

const toPermissionRuleset = (ruleset: unknown): PermissionRule[] => {
  if (!Array.isArray(ruleset)) {
    return [];
  }

  const parsed: PermissionRule[] = [];
  for (const entry of ruleset) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Partial<PermissionRule>;
    if (typeof candidate.permission !== 'string' || typeof candidate.pattern !== 'string' || typeof candidate.action !== 'string') {
      continue;
    }
    if (candidate.action !== 'allow' && candidate.action !== 'ask' && candidate.action !== 'deny') {
      continue;
    }
    parsed.push({ permission: candidate.permission, pattern: candidate.pattern, action: candidate.action });
  }

  return parsed;
};

const normalizeRuleset = (ruleset: PermissionRule[]): PermissionRule[] => {
  const map = new Map<string, PermissionRule>();
  for (const rule of ruleset) {
    if (!rule.permission || rule.permission === 'invalid') {
      continue;
    }
    if (!rule.pattern) {
      continue;
    }
    map.set(`${rule.permission}::${rule.pattern}`, rule);
  }
  return Array.from(map.values());
};

const rulesetToPermissionConfig = (ruleset: unknown): AgentDraft['permission'] => {
  const parsed = normalizeRuleset(toPermissionRuleset(ruleset));
  if (parsed.length === 0) {
    return undefined;
  }

  const byPermission: Record<string, Record<string, PermissionAction>> = {};
  for (const rule of parsed) {
    if (!rule.permission) {
      continue;
    }
    (byPermission[rule.permission] ||= {})[rule.pattern] = rule.action;
  }

  const result: Record<string, PermissionConfigValue> = {};
  for (const [permissionName, map] of Object.entries(byPermission)) {
    const patterns = Object.keys(map);
    if (patterns.length === 1 && patterns[0] === '*') {
      result[permissionName] = map['*'];
      continue;
    }
    result[permissionName] = map;
  }

  return Object.keys(result).length > 0 ? (result as AgentDraft['permission']) : undefined;
};

export const AgentsSidebar: React.FC<AgentsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const [renameDialogAgent, setRenameDialogAgent] = React.useState<Agent | null>(null);
  const [renameNewName, setRenameNewName] = React.useState('');
  const [confirmActionAgent, setConfirmActionAgent] = React.useState<Agent | null>(null);
  const [confirmActionType, setConfirmActionType] = React.useState<'delete' | 'reset' | null>(null);
  const [isConfirmActionPending, setIsConfirmActionPending] = React.useState(false);
  const [openMenuAgent, setOpenMenuAgent] = React.useState<string | null>(null);

  const {
    selectedAgentName,
    agents,
    setSelectedAgent,
    setAgentDraft,
    createAgent,
    deleteAgent,
    loadAgents,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    agents: s.agents,
    setSelectedAgent: s.setSelectedAgent,
    setAgentDraft: s.setAgentDraft,
    createAgent: s.createAgent,
    deleteAgent: s.deleteAgent,
    loadAgents: s.loadAgents,
  })));

  React.useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const bgClass = 'bg-background';

  const handleCreateNew = () => {
    // Generate unique name
    const baseName = 'new-agent';
    let newName = baseName;
    let counter = 1;
    while (agents.some((a) => a.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    // Set draft and open the page for editing
    setAgentDraft({ name: newName, scope: 'user' });
    setSelectedAgent(newName);
    onItemSelect?.();

  };

  const handleDeleteAgent = async (agent: Agent) => {
    if (isAgentBuiltIn(agent)) {
      toast.error(t('settings.agents.sidebar.toast.builtInCannotDelete'));
      return;
    }

    setConfirmActionAgent(agent);
    setConfirmActionType('delete');
  };

  const handleResetAgent = async (agent: Agent) => {
    if (!isAgentBuiltIn(agent)) {
      return;
    }

    setConfirmActionAgent(agent);
    setConfirmActionType('reset');
  };

  const closeConfirmActionDialog = () => {
    setConfirmActionAgent(null);
    setConfirmActionType(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmActionAgent || !confirmActionType) {
      return;
    }

    setIsConfirmActionPending(true);
    const success = await deleteAgent(confirmActionAgent.name);

    if (success) {
      if (confirmActionType === 'delete') {
        toast.success(t('settings.agents.sidebar.toast.agentDeleted', { name: confirmActionAgent.name }));
      } else {
        toast.success(t('settings.agents.sidebar.toast.agentReset', { name: confirmActionAgent.name }));
      }
      closeConfirmActionDialog();
    } else if (confirmActionType === 'delete') {
      toast.error(t('settings.agents.sidebar.toast.deleteFailed'));
    } else {
      toast.error(t('settings.agents.sidebar.toast.resetFailed'));
    }

    setIsConfirmActionPending(false);
  };

  const handleDuplicateAgent = (agent: Agent) => {
    const baseName = agent.name;
    let copyNumber = 1;
    let newName = `${baseName}-copy`;

    while (agents.some((a) => a.name === newName)) {
      copyNumber++;
      newName = `${baseName}-copy-${copyNumber}`;
    }

    // Set draft with prefilled values from source agent
    const extAgent = agent as Agent & { scope?: AgentScope };
    const modelStr = agent.model?.providerID && agent.model?.modelID
      ? `${agent.model.providerID}/${agent.model.modelID}`
      : null;
    const draftAgent = agent as Agent & { disable?: boolean };
    setAgentDraft({
      name: newName,
      scope: extAgent.scope || 'user',
      description: agent.description,
      model: modelStr,
      temperature: agent.temperature,
      top_p: agent.topP,
      prompt: agent.prompt,
      mode: agent.mode,
      permission: rulesetToPermissionConfig(agent.permission),
      disable: draftAgent.disable,
    });
    setSelectedAgent(newName);

  };

  const handleOpenRenameDialog = (agent: Agent) => {
    setRenameNewName(agent.name);
    setRenameDialogAgent(agent);
  };

  const handleRenameAgent = async () => {
    if (!renameDialogAgent) return;

    const sanitizedName = renameNewName.trim().replace(/\s+/g, '-');

    if (!sanitizedName) {
      toast.error(t('settings.agents.sidebar.toast.agentNameRequired'));
      return;
    }

    if (sanitizedName === renameDialogAgent.name) {
      setRenameDialogAgent(null);
      return;
    }

    if (agents.some((a) => a.name === sanitizedName)) {
      toast.error(t('settings.agents.sidebar.toast.agentExists'));
      return;
    }

    // Create new agent with new name and all existing config
    const renameModelStr = renameDialogAgent.model?.providerID && renameDialogAgent.model?.modelID
      ? `${renameDialogAgent.model.providerID}/${renameDialogAgent.model.modelID}`
      : null;
    const renameExt = renameDialogAgent as Agent & { scope?: AgentScope; disable?: boolean };
    const success = await createAgent({
      name: sanitizedName,
      description: renameDialogAgent.description,
      model: renameModelStr,
      temperature: renameDialogAgent.temperature,
      top_p: renameDialogAgent.topP,
      prompt: renameDialogAgent.prompt,
      mode: renameDialogAgent.mode,
      permission: rulesetToPermissionConfig(renameDialogAgent.permission),
      disable: renameExt.disable,
      scope: renameExt.scope,
    });

    if (success) {
      // Delete old agent
      const deleteSuccess = await deleteAgent(renameDialogAgent.name);
      if (deleteSuccess) {
        toast.success(`Agent renamed to "${sanitizedName}"`);
        setSelectedAgent(sanitizedName);
      } else {
        toast.error(t('settings.agents.sidebar.toast.removeOldAfterRenameFailed'));
      }
    } else {
      toast.error(t('settings.agents.sidebar.toast.renameFailed'));
    }

    setRenameDialogAgent(null);
  };

  const getAgentModeIcon = (mode?: string) => {
    switch (mode) {
      case 'primary':
        return <Icon name="ai-agent" className="h-3 w-3 text-primary" />;
      case 'all':
        return <Icon name="ai-agent-fill" className="h-3 w-3 text-primary" />;
      case 'subagent':
        return <Icon name="robot" className="h-3 w-3 text-primary" />;
      default:
        return null;
    }
  };

  // Filter out hidden agents (internal agents like title, compaction, summary)
  const visibleAgents = agents.filter((agent) => !isAgentHidden(agent));
  const builtInAgents = visibleAgents.filter(isAgentBuiltIn);
  const customAgents = visibleAgents.filter((agent) => !isAgentBuiltIn(agent));

  // Group custom agents by subfolder
  const { groupedCustomAgents, ungroupedCustomAgents } = useMemo(() => {
    const groups: Record<string, typeof customAgents> = {};
    const ungrouped: typeof customAgents = [];
    for (const agent of customAgents) {
      const ext = agent as { group?: string };
      if (ext.group) {
        if (!groups[ext.group]) groups[ext.group] = [];
        groups[ext.group].push(agent);
      } else {
        ungrouped.push(agent);
      }
    }
    const sortedGroups = Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, agents: groups[name] }));
    return { groupedCustomAgents: sortedGroups, ungroupedCustomAgents: ungrouped };
  }, [customAgents]);

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.agents.sidebar.title')}</h2>
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.agents.sidebar.total', { count: visibleAgents.length })}</span>
          <Button size="sm"
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={handleCreateNew}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {visibleAgents.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <Icon name="robot-2" className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.agents.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.agents.sidebar.empty.description')}</p>
          </div>
        ) : (
          <>
            {builtInAgents.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.agents.sidebar.section.builtIn')}
                </div>
                {builtInAgents.map((agent) => (
                  <AgentListItem
                    key={agent.name}
                    agent={agent}
                    isSelected={selectedAgentName === agent.name}
                    onSelect={() => {
                      setSelectedAgent(agent.name);
                      onItemSelect?.();

                    }}
                    onReset={() => handleResetAgent(agent)}
                    onDuplicate={() => handleDuplicateAgent(agent)}
                    getAgentModeIcon={getAgentModeIcon}
                    isMenuOpen={openMenuAgent === agent.name}
                    onMenuOpenChange={(open) => setOpenMenuAgent(open ? agent.name : null)}
                  />
                ))}
              </>
            )}

            {customAgents.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.agents.sidebar.section.custom')}
                </div>

                {/* Grouped agents by subfolder */}
                {groupedCustomAgents.map(({ name: groupName, agents: groupAgents }) => (
                  <SidebarGroup
                    key={groupName}
                    label={groupName}
                    count={groupAgents.length}
                    storageKey="agents"
                  >
                    {groupAgents.map((agent) => (
                      <AgentListItem
                        key={agent.name}
                        agent={agent}
                        isSelected={selectedAgentName === agent.name}
                        onSelect={() => {
                          setSelectedAgent(agent.name);
                          onItemSelect?.();

                        }}
                        onRename={() => handleOpenRenameDialog(agent)}
                        onDelete={() => handleDeleteAgent(agent)}
                        onDuplicate={() => handleDuplicateAgent(agent)}
                        getAgentModeIcon={getAgentModeIcon}
                        isMenuOpen={openMenuAgent === agent.name}
                        onMenuOpenChange={(open) => setOpenMenuAgent(open ? agent.name : null)}
                      />
                    ))}
                  </SidebarGroup>
                ))}

                {/* Ungrouped agents (flat in root agents dir) */}
                {ungroupedCustomAgents.map((agent) => (
                  <AgentListItem
                    key={agent.name}
                    agent={agent}
                    isSelected={selectedAgentName === agent.name}
                    onSelect={() => {
                      setSelectedAgent(agent.name);
                      onItemSelect?.();

                    }}
                    onRename={() => handleOpenRenameDialog(agent)}
                    onDelete={() => handleDeleteAgent(agent)}
                    onDuplicate={() => handleDuplicateAgent(agent)}
                    getAgentModeIcon={getAgentModeIcon}
                    isMenuOpen={openMenuAgent === agent.name}
                    onMenuOpenChange={(open) => setOpenMenuAgent(open ? agent.name : null)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>

      <Dialog
        open={confirmActionAgent !== null && confirmActionType !== null}
        onOpenChange={(open) => {
          if (!open && !isConfirmActionPending) {
            closeConfirmActionDialog();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmActionType === 'delete' ? t('settings.agents.sidebar.dialog.deleteTitle') : t('settings.agents.sidebar.dialog.resetTitle')}</DialogTitle>
            <DialogDescription>
              {confirmActionType === 'delete'
                ? t('settings.agents.sidebar.dialog.deleteDescription', { name: confirmActionAgent?.name ?? '' })
                : t('settings.agents.sidebar.dialog.resetDescription', { name: confirmActionAgent?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={closeConfirmActionDialog}
              disabled={isConfirmActionPending}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleConfirmAction} disabled={isConfirmActionPending}>
              {confirmActionType === 'delete' ? t('settings.common.actions.delete') : t('settings.common.actions.reset')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogAgent !== null} onOpenChange={(open) => !open && setRenameDialogAgent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.agents.sidebar.renameDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.agents.sidebar.renameDialog.description', { name: renameDialogAgent?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            placeholder={t('settings.agents.sidebar.renameDialog.placeholder')}
            className="text-foreground placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRenameAgent();
              }
            }}
          />
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRenameDialogAgent(null)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleRenameAgent}>
              {t('settings.common.actions.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  onReset?: () => void;
  onRename?: () => void;
  onDuplicate: () => void;
  getAgentModeIcon: (mode?: string) => React.ReactNode;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

const AgentListItem: React.FC<AgentListItemProps> = ({
  agent,
  isSelected,
  onSelect,
  onDelete,
  onReset,
  onRename,
  onDuplicate,
  getAgentModeIcon,
  isMenuOpen,
  onMenuOpenChange,
}) => {
  const { t } = useI18n();
  const extAgent = agent as Agent & { scope?: AgentScope };
  const isMobile = isMobileDeviceViaCSS();
  
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
      onContextMenu={!isMobile ? (e) => {
        e.preventDefault();
        onMenuOpenChange(true);
      } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          tabIndex={0}
        >
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label font-normal truncate text-foreground">
              {agent.name}
            </span>
            {getAgentModeIcon(agent.mode)}
            {(extAgent.scope || isAgentBuiltIn(agent)) && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {isAgentBuiltIn(agent) ? t('settings.agents.sidebar.badge.system') : extAgent.scope}
              </span>
            )}
          </div>

          {agent.description && (
            <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
              {agent.description}
            </div>
          )}
        </button>

        <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button size="sm"
              variant="ghost"
              className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            >
              <Icon name="more-2" className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-fit min-w-20">
            {onRename && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
              >
                <Icon name="edit" className="h-4 w-4 mr-px" />
                {t('settings.common.actions.rename')}
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
            >
              <Icon name="file-copy" className="h-4 w-4 mr-px" />
              {t('settings.common.actions.duplicate')}
            </DropdownMenuItem>

            {onReset && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onReset();
                }}
              >
                <Icon name="restart" className="h-4 w-4 mr-px" />
                {t('settings.common.actions.reset')}
              </DropdownMenuItem>
            )}

            {onDelete && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Icon name="delete-bin" className="h-4 w-4 mr-px" />
                {t('settings.common.actions.delete')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
