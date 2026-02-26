import React from 'react';
import {
  RiAddLine,
  RiDeleteBinLine,
  RiPlayLine,
} from '@remixicon/react';
import { ButtonSmall } from '@/components/ui/button-small';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import {
  getProjectActionsState,
  saveProjectActionsState,
  type OpenChamberProjectAction,
  type OpenChamberProjectActionPlatform,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import {
  getCurrentProjectActionPlatform,
  PROJECT_ACTIONS_UPDATED_EVENT,
  PROJECT_ACTION_ICON_MAP,
  PROJECT_ACTION_ICONS,
} from '@/lib/projectActions';
import { cn } from '@/lib/utils';

type EditableProjectAction = OpenChamberProjectAction;

const PLATFORM_LABELS: Record<OpenChamberProjectActionPlatform, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};

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
  const [actions, setActions] = React.useState<EditableProjectAction[]>([]);
  const [primaryActionId, setPrimaryActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialSnapshot, setInitialSnapshot] = React.useState<string | null>(null);

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
        setPrimaryActionId(state.primaryActionId);
        setInitialSnapshot(JSON.stringify(state));
      } catch {
        if (cancelled) {
          return;
        }
        setActions([]);
        setPrimaryActionId(null);
        setInitialSnapshot(JSON.stringify({ actions: [], primaryActionId: null }));
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
    return initialSnapshot !== JSON.stringify({ actions, primaryActionId });
  }, [actions, initialSnapshot, primaryActionId]);

  const handleAddAction = React.useCallback(() => {
    setActions((prev) => [...prev, createEmptyAction()]);
  }, []);

  const handleRemoveAction = React.useCallback((id: string) => {
    setActions((prev) => prev.filter((entry) => entry.id !== id));
    setPrimaryActionId((prev) => (prev === id ? null : prev));
  }, []);

  const updateAction = React.useCallback((id: string, updater: (current: EditableProjectAction) => EditableProjectAction) => {
    setActions((prev) => prev.map((entry) => (entry.id === id ? updater(entry) : entry)));
  }, []);

  const togglePlatform = React.useCallback((id: string, platform: OpenChamberProjectActionPlatform) => {
    updateAction(id, (current) => {
      const currentPlatforms = Array.isArray(current.platforms) ? current.platforms : [];
      const hasPlatform = currentPlatforms.includes(platform);
      const nextPlatforms = hasPlatform
        ? currentPlatforms.filter((entry) => entry !== platform)
        : [...currentPlatforms, platform];

      return {
        ...current,
        ...(nextPlatforms.length > 0 ? { platforms: nextPlatforms } : { platforms: undefined }),
      };
    });
  }, [updateAction]);

  const togglePlatformSpecific = React.useCallback((id: string, enabled: boolean) => {
    if (!enabled) {
      updateAction(id, (current) => ({ ...current, platforms: undefined }));
      return;
    }

    const defaultPlatform = getCurrentProjectActionPlatform();
    updateAction(id, (current) => ({ ...current, platforms: [defaultPlatform] }));
  }, [updateAction]);

  const handleSave = React.useCallback(async () => {
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setIsSaving(true);
    try {
      const ok = await saveProjectActionsState(projectRef, {
        actions,
        primaryActionId,
      });
      if (!ok) {
        toast.error('Failed to save actions');
        return;
      }
      setInitialSnapshot(JSON.stringify({ actions, primaryActionId }));
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
  }, [actions, primaryActionId, projectRef, validationError]);

  const canSave = !isSaving && !isLoading && hasChanges && !validationError;

  return (
    <div className="space-y-3">
      <div className="mb-1 px-1 flex items-center justify-between gap-2">
        <div>
          <h3 className="typography-ui-header font-medium text-foreground">Actions</h3>
          <p className="typography-meta text-muted-foreground">
            Configure per-project commands shown in header.
          </p>
        </div>
        <ButtonSmall type="button" variant="ghost" size="xs" className="!font-normal" onClick={handleAddAction}>
          <RiAddLine className="h-3.5 w-3.5" />
          Add action
        </ButtonSmall>
      </div>

      {isLoading ? (
        <p className="typography-meta text-muted-foreground px-1">Loading...</p>
      ) : actions.length === 0 ? (
        <div className="rounded-md border border-border/50 bg-[var(--surface-elevated)]/50 p-3">
          <p className="typography-meta text-muted-foreground">No actions configured.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {actions.map((action) => {
            const selectedIconKey = (action.icon as keyof typeof PROJECT_ACTION_ICON_MAP) || 'play';
            const SelectedIcon = PROJECT_ACTION_ICON_MAP[selectedIconKey] || RiPlayLine;
            const isPlatformSpecific = Array.isArray(action.platforms) && action.platforms.length > 0;

            return (
              <div key={action.id} className="rounded-lg border border-border/50 bg-[var(--surface-elevated)] p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--interactive-border)] text-foreground hover:bg-[var(--interactive-hover)]"
                        aria-label="Select icon"
                      >
                        <SelectedIcon className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-40">
                      {PROJECT_ACTION_ICONS.map((entry) => {
                        const Icon = entry.Icon;
                        return (
                          <DropdownMenuItem
                            key={entry.key}
                            onClick={() => updateAction(action.id, (current) => ({ ...current, icon: entry.key }))}
                            className="flex items-center gap-2"
                          >
                            <Icon className="h-4 w-4" />
                            <span>{entry.label}</span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Input
                    value={action.name}
                    onChange={(event) => updateAction(action.id, (current) => ({ ...current, name: event.target.value }))}
                    placeholder="Action name"
                    className="h-8"
                  />

                  <button
                    type="button"
                    onClick={() => handleRemoveAction(action.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    aria-label="Remove action"
                  >
                    <RiDeleteBinLine className="h-4 w-4" />
                  </button>
                </div>

                <Textarea
                  value={action.command}
                  onChange={(event) => updateAction(action.id, (current) => ({ ...current, command: event.target.value }))}
                  placeholder="e.g. bun run lint"
                  className="min-h-[90px] font-mono text-xs"
                />

                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={isPlatformSpecific}
                      onChange={(event) => togglePlatformSpecific(action.id, event.target.checked)}
                      className="h-4 w-4 rounded border-[var(--interactive-border)]"
                    />
                    <span className="typography-meta">Platform specific</span>
                  </label>

                  {isPlatformSpecific && (
                    <div className="inline-flex items-center gap-1">
                      {(['macos', 'linux', 'windows'] as OpenChamberProjectActionPlatform[]).map((platform) => {
                        const selected = action.platforms?.includes(platform) ?? false;
                        return (
                          <button
                            key={platform}
                            type="button"
                            onClick={() => togglePlatform(action.id, platform)}
                            className={cn(
                              'h-7 rounded-full px-3 typography-ui-label transition-colors',
                              selected
                                ? 'bg-interactive-selection text-interactive-selection-foreground'
                                : 'text-muted-foreground hover:bg-interactive-hover'
                            )}
                          >
                            {PLATFORM_LABELS[platform]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <label className="inline-flex items-center gap-2 text-muted-foreground">
                  <input
                    type="radio"
                    checked={primaryActionId === action.id}
                    onChange={() => setPrimaryActionId(action.id)}
                    className="h-4 w-4 border-[var(--interactive-border)]"
                    name={`project-action-primary-${projectRef.id}`}
                  />
                  <span className="typography-meta">Default header action</span>
                </label>

                <label className="inline-flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={action.autoOpenUrl === true}
                    onChange={(event) => updateAction(action.id, (current) => ({
                      ...current,
                      ...(event.target.checked ? { autoOpenUrl: true } : { autoOpenUrl: undefined }),
                    }))}
                    className="h-4 w-4 rounded border-[var(--interactive-border)]"
                  />
                  <span className="typography-meta">Auto-open first URL from output</span>
                </label>
              </div>
            );
          })}
        </div>
      )}

      <div className="px-1">
        {validationError && (
          <p className="typography-meta mb-2 text-[var(--status-warning)]">{validationError}</p>
        )}
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
    </div>
  );
};
