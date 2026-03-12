import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiInformationLine,
  RiPlayLine,
} from '@remixicon/react';
import { ButtonSmall } from '@/components/ui/button-small';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { isDesktopShell } from '@/lib/desktop';
import {
  getProjectActionsState,
  saveProjectActionsState,
  type OpenChamberProjectAction,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import {
  buildProjectActionDesktopForwardOptions,
  PROJECT_ACTION_ICON_MAP,
  PROJECT_ACTION_ICONS,
  PROJECT_ACTIONS_UPDATED_EVENT,
} from '@/lib/projectActions';
import { cn } from '@/lib/utils';

type EditableProjectAction = OpenChamberProjectAction;

const createActionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
};

const createEmptyAction = (): EditableProjectAction => ({
  id: createActionId(),
  name: '',
  command: '',
  icon: 'play',
});

interface ProjectActionsSectionProps {
  projectRef: ProjectRef;
}

export const ProjectActionsSection: React.FC<ProjectActionsSectionProps> = ({ projectRef }) => {
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const [actions, setActions] = React.useState<EditableProjectAction[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialSnapshot, setInitialSnapshot] = React.useState<string | null>(null);
  const [expandedActions, setExpandedActions] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (!isDesktopShellApp) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh]);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const state = await getProjectActionsState(projectRef);
        if (cancelled) {
          return;
        }
        setActions(state.actions);
        setInitialSnapshot(JSON.stringify({ actions: state.actions }));
      } catch {
        if (cancelled) {
          return;
        }
        setActions([]);
        setInitialSnapshot(JSON.stringify({ actions: [] }));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef]);

  const desktopForwardOptions = React.useMemo(() => {
    if (!isDesktopShellApp) {
      return [];
    }
    return buildProjectActionDesktopForwardOptions(desktopSshInstances);
  }, [desktopSshInstances, isDesktopShellApp]);

  const validationError = React.useMemo(() => {
    const hasIncomplete = actions.some((entry) => {
      return entry.name.trim().length === 0 || entry.command.trim().length === 0;
    });
    if (hasIncomplete) {
      return 'Fill action name and command before saving.';
    }
    return null;
  }, [actions]);

  const hasChanges = React.useMemo(() => {
    if (initialSnapshot === null) {
      return false;
    }
    return initialSnapshot !== JSON.stringify({ actions });
  }, [actions, initialSnapshot]);

  const handleAddAction = React.useCallback(() => {
    const nextAction = createEmptyAction();
    setActions((prev) => [...prev, nextAction]);
    setExpandedActions((prev) => ({
      ...prev,
      [nextAction.id]: true,
    }));
  }, []);

  const handleRemoveAction = React.useCallback((id: string) => {
    setActions((prev) => prev.filter((entry) => entry.id !== id));
    setExpandedActions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateAction = React.useCallback((id: string, updater: (current: EditableProjectAction) => EditableProjectAction) => {
    setActions((prev) => prev.map((entry) => (entry.id === id ? updater(entry) : entry)));
  }, []);

  const handleSave = React.useCallback(async () => {
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setIsSaving(true);
    try {
      const ok = await saveProjectActionsState(projectRef, {
        actions,
        primaryActionId: null,
      });
      if (!ok) {
        toast.error('Failed to save actions');
        return;
      }
      setInitialSnapshot(JSON.stringify({ actions }));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(PROJECT_ACTIONS_UPDATED_EVENT, {
          detail: { projectId: projectRef.id },
        }));
      }
      toast.success('Project actions saved');
    } catch {
      toast.error('Failed to save actions');
    } finally {
      setIsSaving(false);
    }
  }, [actions, projectRef, validationError]);

  const canSave = !isSaving && !isLoading && hasChanges && !validationError;

  return (
    <div className="mb-8">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <h3 className="typography-ui-header font-medium text-foreground">Actions</h3>
          <p className="typography-meta text-muted-foreground">Per-project commands shown in header next to project name.</p>
        </div>
        <ButtonSmall type="button" variant="outline" size="xs" className="!font-normal" onClick={handleAddAction}>
          <RiAddLine className="h-3.5 w-3.5" />
          Add action
        </ButtonSmall>
      </div>

      <section className="pb-2 pt-0 space-y-2">
        {isLoading ? (
          <p className="typography-meta text-muted-foreground">Loading...</p>
        ) : actions.length === 0 ? (
          <div className="py-2">
            <p className="typography-meta text-muted-foreground">No actions configured yet.</p>
          </div>
        ) : (
          <div className="space-y-0 max-w-[30rem]">
            {actions.map((action) => {
              const selectedIconKey = (action.icon as keyof typeof PROJECT_ACTION_ICON_MAP) || 'play';
              const SelectedIcon = PROJECT_ACTION_ICON_MAP[selectedIconKey] || RiPlayLine;
              const isOpen = expandedActions[action.id] ?? false;
              const title = action.name.trim() || 'Untitled action';

              return (
                <Collapsible
                  key={action.id}
                  open={isOpen}
                  onOpenChange={(open) => {
                    setExpandedActions((prev) => ({
                      ...prev,
                      [action.id]: open,
                    }));
                  }}
                  className={cn(
                    'py-1.5'
                  )}
                >
                  <div className="flex items-start gap-2">
                    <CollapsibleTrigger className="group flex-1 justify-start gap-2 rounded-md px-0 pr-1 py-1 hover:bg-[var(--interactive-hover)] focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
                      {isOpen ? (
                        <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />
                      )}
                      <SelectedIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="typography-ui-label text-foreground truncate">{title}</span>
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <ButtonSmall
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal h-7 w-7 px-0 text-muted-foreground hover:text-[var(--status-error)]"
                      onClick={() => handleRemoveAction(action.id)}
                    >
                      <RiDeleteBinLine className="h-3.5 w-3.5" />
                    </ButtonSmall>
                  </div>

                  <CollapsibleContent className="pt-1.5">
                    <div className="space-y-2 pb-6 pl-3 pr-3">
                      <div className="flex items-center gap-2 py-1">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--interactive-border)] text-foreground hover:bg-[var(--interactive-hover)]"
                                aria-label="Select icon"
                              >
                                <SelectedIcon className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56 p-2">
                              <div className="grid grid-cols-6 gap-1">
                              {PROJECT_ACTION_ICONS.map((entry) => {
                                const Icon = entry.Icon;
                                const selected = (action.icon || 'play') === entry.key;
                                return (
                                  <button
                                    key={entry.key}
                                    type="button"
                                    onClick={() => updateAction(action.id, (current) => ({ ...current, icon: entry.key }))}
                                    className={cn(
                                      'inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-foreground hover:bg-[var(--interactive-hover)]',
                                      selected && 'border-[var(--primary-base)] bg-[var(--primary-base)]/10 text-[var(--primary-base)]'
                                    )}
                                    aria-label={`Icon ${entry.label}`}
                                  >
                                    <Icon className="h-4 w-4" />
                                  </button>
                                );
                              })}
                              </div>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          <Input
                            value={action.name}
                            onChange={(event) => updateAction(action.id, (current) => ({ ...current, name: event.target.value }))}
                            placeholder="Action name"
                            className="h-7 max-w-[14rem]"
                          />
                      </div>

                      <div className="py-1">
                        <p className="typography-meta mb-0.5 text-muted-foreground">Command</p>
                        <Textarea
                          value={action.command}
                          onChange={(event) => updateAction(action.id, (current) => ({ ...current, command: event.target.value }))}
                          placeholder="e.g. bun run lint"
                          className="min-h-[88px] max-w-[30rem] font-mono text-xs"
                        />
                      </div>

                      <div className="py-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="typography-ui-label text-foreground">Auto-open URL</span>
                          <div
                            className="group flex cursor-pointer items-center gap-2"
                            role="button"
                            tabIndex={0}
                            aria-pressed={action.autoOpenUrl === true}
                            onClick={() => updateAction(action.id, (current) => ({
                              ...current,
                              ...(current.autoOpenUrl === true ? { autoOpenUrl: undefined } : { autoOpenUrl: true }),
                            }))}
                            onKeyDown={(event) => {
                              if (event.key === ' ' || event.key === 'Enter') {
                                event.preventDefault();
                                updateAction(action.id, (current) => ({
                                  ...current,
                                  ...(current.autoOpenUrl === true ? { autoOpenUrl: undefined } : { autoOpenUrl: true }),
                                }));
                              }
                            }}
                          >
                            <Checkbox
                              checked={action.autoOpenUrl === true}
                              onChange={(checked) => updateAction(action.id, (current) => ({
                                ...current,
                                ...(checked ? { autoOpenUrl: true } : { autoOpenUrl: undefined }),
                              }))}
                              ariaLabel={`Auto-open URL for ${title}`}
                            />
                            <span className="typography-ui-label font-normal text-foreground/80">Open URL from output or custom URL below</span>
                          </div>
                        </div>

                        {action.autoOpenUrl === true ? (
                          <div className="mt-1">
                            <div className="flex items-center gap-2">
                              <Input
                                value={action.openUrl || ''}
                                onChange={(event) => updateAction(action.id, (current) => ({
                                  ...current,
                                  openUrl: event.target.value,
                                }))}
                                placeholder="Override URL (optional)"
                                className="h-7 w-full max-w-[24rem]"
                              />
                              <Tooltip delayDuration={1000}>
                                <TooltipTrigger asChild>
                                  <RiInformationLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent sideOffset={8} className="max-w-xs">
                                  If this field is filled, custom URL is used. If empty, app opens best URL from output.
                                </TooltipContent>
                              </Tooltip>
                            </div>

                            {isDesktopShellApp ? (
                              <div className="mt-2">
                                <p className="typography-meta mb-0.5 text-muted-foreground">Desktop SSH forward</p>
                                {desktopForwardOptions.length > 0 ? (
                                  <Select
                                    value={
                                      action.desktopOpenSshForward && desktopForwardOptions.some((entry) => entry.id === action.desktopOpenSshForward)
                                        ? action.desktopOpenSshForward
                                        : '__none__'
                                    }
                                    onValueChange={(value) => {
                                      updateAction(action.id, (current) => ({
                                        ...current,
                                        ...(value === '__none__' ? { desktopOpenSshForward: undefined } : { desktopOpenSshForward: value }),
                                      }));
                                    }}
                                  >
                                    <SelectTrigger className="h-7 w-full max-w-[30rem]">
                                      <SelectValue placeholder="Use output/manual URL" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">Use output/manual URL</SelectItem>
                                      {desktopForwardOptions.map((entry) => (
                                        <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <p className="typography-meta text-muted-foreground">No enabled local SSH forwards available.</p>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        )}

        <div className="pt-3">
          {validationError ? (
            <p className="typography-meta mb-2 text-[var(--status-warning)]">{validationError}</p>
          ) : null}
          <ButtonSmall
            type="button"
            size="xs"
            className="!font-normal"
            onClick={handleSave}
            disabled={!canSave}
          >
            {isSaving ? 'Saving...' : 'Save Actions'}
          </ButtonSmall>
        </div>
      </section>
    </div>
  );
};
