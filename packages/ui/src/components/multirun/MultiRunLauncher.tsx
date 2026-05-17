import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePromptTemplatesStore } from '@/stores/usePromptTemplatesStore';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import type { ProjectRef } from '@/lib/openchamberConfig';
import type { CreateMultiRunParams, MultiRunGroup } from '@/types/multirun';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';
import { BranchSelector, useBranchOptions } from './BranchSelector';
import { AgentSelector } from './AgentSelector';
import { Icon } from "@/components/icon/Icon";
import { isDesktopShell } from '@/lib/desktop';
import { useTabletStandalonePwaRuntime } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import type { ProjectEntry } from '@/lib/api/types';
import { startDesktopWindowDrag } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_MODELS_PER_GROUP = 5;

interface MultiRunAttachedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface RunGroupState {
  id: string;
  templateId: string;
  prompt: string;
  models: ModelSelectionWithId[];
}

interface MultiRunLauncherProps {
  initialPrompt?: string;
  onCreated?: () => void;
  onCancel?: () => void;
  isWindowed?: boolean;
}

const InfoTip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" tabIndex={-1} className="inline-flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground transition-colors">
        <Icon name="information" className="h-3.5 w-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-[240px]">
      {children}
    </TooltipContent>
  </Tooltip>
);

const FieldLabel: React.FC<{
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
  info?: React.ReactNode;
}> = ({ htmlFor, required, children, info }) => (
  <div className="flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="typography-meta font-medium text-foreground">
      {children}
      {required && <span className="text-destructive ml-0.5">*</span>}
    </label>
    {info && info}
  </div>
);

export const MultiRunLauncher: React.FC<MultiRunLauncherProps> = ({
  initialPrompt,
  onCreated,
  onCancel,
  isWindowed = false,
}) => {
  const { t } = useI18n();
  const [name, setName] = React.useState('');
  const [runGroups, setRunGroups] = React.useState<RunGroupState[]>(() => [
    { id: generateInstanceId(), templateId: '', prompt: '', models: [] },
  ]);
  const [selectedAgent, setSelectedAgent] = React.useState<string>('');
  const [attachedFiles, setAttachedFiles] = React.useState<MultiRunAttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [isSetupCommandsOpen, setIsSetupCommandsOpen] = React.useState(false);
  const [isLoadingSetupCommands, setIsLoadingSetupCommands] = React.useState(false);
  const [isolateRuns, setIsolateRuns] = React.useState(true);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const templates = usePromptTemplatesStore((s) => s.templates);

  React.useEffect(() => {
    usePromptTemplatesStore.getState().loadTemplates();
  }, []);

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory ?? null);

  const vscodeWorkspaceFolder = React.useMemo(() => {
    if (typeof window === 'undefined') return null;
    const folder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder;
    return typeof folder === 'string' && folder.trim().length > 0 ? folder.trim() : null;
  }, []);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const projects = useProjectsStore((state) => state.projects);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(() => activeProjectId ?? null);

  React.useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
      return;
    }
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [activeProjectId, projects, selectedProjectId]);

  const selectedProject = React.useMemo(() => {
    if (!selectedProjectId) return null;
    return projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const selectedProjectDirectory = selectedProject?.path ?? currentDirectory;

  const handleProjectChange = React.useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    if (projectId !== activeProjectId) {
      setActiveProjectIdOnly(projectId);
    }
  }, [activeProjectId, setActiveProjectIdOnly]);

  const { currentTheme } = useThemeSystem();

  const renderProjectLabel = React.useCallback((project: ProjectEntry) => {
    const displayLabel = project.label?.trim() || formatDirectoryName(project.path, homeDirectory);
    const imageUrl = getProjectIconImageUrl(
      { id: project.id, iconImage: project.iconImage ?? null },
      {
        themeVariant: currentTheme.metadata.variant,
        iconColor: currentTheme.colors.surface.foreground,
      },
    );
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {imageUrl ? (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
            style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
          >
            <img src={imageUrl} alt="" className="h-full w-full object-contain" draggable={false} />
          </span>
        ) : projectIconName ? (
          <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
        ) : (
          <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"  style={iconColor ? { color: iconColor } : undefined}/>
        )}
        <span className="truncate">{displayLabel}</span>
      </span>
    );
  }, [homeDirectory, currentTheme.metadata.variant, currentTheme.colors.surface.foreground]);

  const projectRef = React.useMemo<ProjectRef | null>(() => {
    if (selectedProject?.path) {
      return { id: selectedProject.id, path: selectedProject.path };
    }
    const base = currentDirectory ?? vscodeWorkspaceFolder;
    if (!base) return null;
    return { id: `path:${base}`, path: base };
  }, [selectedProject, currentDirectory, vscodeWorkspaceFolder]);

  const [isDesktopApp] = React.useState(() => (typeof window !== 'undefined' ? isDesktopShell() : false));

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') return null;
    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) return injected;
    if (typeof navigator === 'undefined') return null;
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) return null;
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) return null;
    return first === 10 ? second : first;
  }, []);

  const desktopHeaderPaddingClass = React.useMemo(() => {
    if ((isDesktopApp && isMacPlatform) || isTabletStandalonePwa) {
      // Match main app header: reserve space for Mac/iPadOS traffic lights.
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
  }, [isDesktopApp, isMacPlatform, isTabletStandalonePwa]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) return '';
    if (macosMajorVersion >= 26) return 'h-12';
    if (macosMajorVersion <= 15) return 'h-14';
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (e.button !== 0) return;
    if (isDesktopApp) await startDesktopWindowDrag();
  }, [isDesktopApp]);

  React.useEffect(() => {
    if (!onCancel) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onCancel]);

  const [worktreeBaseBranch, setWorktreeBaseBranch] = React.useState<string>('');
  const { isLoading: isLoadingWorktreeBaseBranches, isGitRepository } = useBranchOptions(selectedProjectDirectory);
  const wasIsolationDisabledByNonGitRef = React.useRef(false);
  const canIsolateRuns = isGitRepository === true;
  const effectiveIsolateRuns = canIsolateRuns && isolateRuns;

  React.useEffect(() => {
    if (isGitRepository === false) {
      wasIsolationDisabledByNonGitRef.current = true;
      setIsolateRuns(false);
      return;
    }

    if (isGitRepository === true && wasIsolationDisabledByNonGitRef.current) {
      wasIsolationDisabledByNonGitRef.current = false;
      setIsolateRuns(true);
    }
  }, [isGitRepository]);

  const createMultiRun = useMultiRunStore((state) => state.createMultiRun);
  const error = useMultiRunStore((state) => state.error);
  const clearError = useMultiRunStore((state) => state.clearError);

  React.useEffect(() => {
    if (typeof initialPrompt === 'string' && initialPrompt.trim().length > 0) {
      setRunGroups((prev) => {
        const updated = [...prev];
        if (updated.length > 0 && !updated[0].prompt.trim()) {
          updated[0] = { ...updated[0], prompt: initialPrompt };
        }
        return updated;
      });
    }
  }, [initialPrompt]);

  React.useEffect(() => {
    if (!projectRef) return;
    let cancelled = false;
    setIsLoadingSetupCommands(true);
    (async () => {
      try {
        const commands = await getWorktreeSetupCommands(projectRef);
        if (!cancelled) setSetupCommands(commands);
      } catch {
        // Ignore
      } finally {
        if (!cancelled) setIsLoadingSetupCommands(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectRef]);

  const updateGroup = React.useCallback((groupId: string, updates: Partial<RunGroupState>) => {
    setRunGroups((prev) => prev.map((g) => g.id === groupId ? { ...g, ...updates } : g));
  }, []);

  const removeGroup = React.useCallback((groupId: string) => {
    setRunGroups((prev) => prev.filter((g) => g.id !== groupId));
  }, []);

  const addGroup = React.useCallback(() => {
    setRunGroups((prev) => [...prev, { id: generateInstanceId(), templateId: '', prompt: '', models: [] }]);
  }, []);

  const handleTemplateChange = React.useCallback((groupId: string, templateId: string) => {
    const template = templateId ? templates.find((t) => t.id === templateId) : null;
    updateGroup(groupId, {
      templateId,
      prompt: template ? template.body : '',
    });
  }, [templates, updateGroup]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    let attachedCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_FILE_SIZE) {
        toast.error(t('multirun.launcher.toast.fileTooLarge', { fileName: file.name }));
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setAttachedFiles((prev) => [...prev, {
          id: generateInstanceId(),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl,
        }]);
        attachedCount++;
      } catch (err) {
        console.error('File attach failed', err);
        toast.error(t('multirun.launcher.toast.attachFailed', { fileName: file.name }));
      }
    }
    if (attachedCount > 0) {
      toast.success(
        attachedCount === 1
          ? t('multirun.launcher.toast.attachedSingle', { count: attachedCount })
          : t('multirun.launcher.toast.attachedPlural', { count: attachedCount }),
      );
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const totalRunCount = React.useMemo(
    () => runGroups.reduce((sum, g) => sum + g.models.length, 0),
    [runGroups],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validGroups = runGroups.filter((g) => g.prompt.trim() && g.models.length >= 1);
    if (validGroups.length === 0) return;
    if (totalRunCount < 1) return;

    setIsSubmitting(true);
    clearError();

    try {
      if (selectedProjectId && selectedProjectId !== activeProjectId) {
        setActiveProjectIdOnly(selectedProjectId);
      }

      const filesForStore = attachedFiles.map((f) => ({
        mime: f.mimeType,
        filename: f.filename,
        url: f.dataUrl,
      }));

      const commandsForStore = setupCommands.filter((cmd) => cmd.trim().length > 0);

      const groups: MultiRunGroup[] = validGroups.map((g) => ({
        prompt: g.prompt.trim(),
        models: g.models.map((m) => ({ providerID: m.providerID, modelID: m.modelID, displayName: m.displayName, variant: m.variant })),
        templateId: g.templateId || undefined,
      }));

      const params: CreateMultiRunParams = {
        name: name.trim(),
        groups,
        agent: selectedAgent || undefined,
        worktreeBaseBranch: effectiveIsolateRuns ? worktreeBaseBranch : undefined,
        isolateRuns: effectiveIsolateRuns,
        files: filesForStore.length > 0 ? filesForStore : undefined,
        setupCommands: commandsForStore.length > 0 ? commandsForStore : undefined,
      };

      const result = await createMultiRun(params);
      if (result) {
        if (result.firstSessionId) {
          useSessionUIStore.getState().setCurrentSession(result.firstSessionId);
        }
        onCreated?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = Boolean(
    name.trim()
    && runGroups.some((g) => g.prompt.trim() && g.models.length >= 1)
    && totalRunCount >= 1
    && selectedProjectDirectory
    && !isLoadingWorktreeBaseBranches
    && (isGitRepository === false || !effectiveIsolateRuns || worktreeBaseBranch)
  );

  const configuredSetupCount = setupCommands.filter((cmd) => cmd.trim()).length;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full bg-background">
      {!isWindowed ? (
        <header
          onMouseDown={handleDragStart}
          className={cn(
            'relative flex h-12 shrink-0 items-center justify-center border-b app-region-drag select-none',
            desktopHeaderPaddingClass,
            macosHeaderSizeClass,
          )}
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <h1 className="typography-ui-label font-medium">{t('multirun.launcher.title')}</h1>
          {onCancel && (
            <div className="absolute right-0 flex items-center pr-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onCancel}
                    aria-label={t('multirun.launcher.actions.closeEsc')}
                    className="inline-flex h-9 w-9 items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary app-region-no-drag"
                  >
                    <Icon name="close" className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent><p>{t('multirun.launcher.actions.closeEsc')}</p></TooltipContent>
              </Tooltip>
            </div>
          )}
        </header>
      ) : null}

      <ScrollShadow className="flex-1 min-h-0 overflow-auto" size={64} hideTopShadow>
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-5">
          <div className="flex flex-col gap-5">

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="multirun-project" required>{t('multirun.launcher.project.label')}</FieldLabel>
                {projects.length > 0 ? (
                  <Select value={selectedProjectId ?? undefined} onValueChange={handleProjectChange}>
                    <SelectTrigger id="multirun-project" size="lg" className="w-fit max-w-full">
                      {selectedProject ? (
                        <SelectValue>{renderProjectLabel(selectedProject)}</SelectValue>
                      ) : (
                        <SelectValue placeholder={t('multirun.launcher.project.placeholder')} />
                      )}
                    </SelectTrigger>
                    <SelectContent fitContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id} className="max-w-[24rem]">
                          {renderProjectLabel(project)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="typography-micro text-muted-foreground py-2">{t('multirun.launcher.project.empty')}</p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="group-name" required info={<InfoTip>{t('multirun.launcher.groupName.info')}</InfoTip>}>
                  {t('multirun.launcher.groupName.label')}
                </FieldLabel>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('multirun.launcher.groupName.placeholder')}
                  className="typography-meta w-full"
                  required
                />
              </div>

              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="multirun-worktree-base-branch" info={<InfoTip>{t('multirun.launcher.baseBranch.info')}</InfoTip>}>
                  {t('multirun.launcher.baseBranch.label')}
                </FieldLabel>
                <BranchSelector
                  directory={selectedProjectDirectory}
                  value={worktreeBaseBranch}
                  onChange={setWorktreeBaseBranch}
                  disabled={!effectiveIsolateRuns}
                  id="multirun-worktree-base-branch"
                />
                <label className="mt-1.5 flex w-fit items-center gap-1.5 typography-micro text-muted-foreground">
                  <Checkbox
                    checked={isolateRuns}
                    onChange={setIsolateRuns}
                    disabled={!canIsolateRuns}
                    ariaLabel={t('multirun.launcher.isolateRuns.label')}
                  />
                  <span>{t('multirun.launcher.isolateRuns.label')}</span>
                </label>
              </div>

              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="multirun-agent" info={<InfoTip>{t('multirun.launcher.agent.info')}</InfoTip>}>
                  {t('multirun.launcher.agent.label')}
                </FieldLabel>
                <AgentSelector value={selectedAgent} onChange={setSelectedAgent} id="multirun-agent" />
              </div>
            </div>

            <Collapsible open={isSetupCommandsOpen} onOpenChange={setIsSetupCommandsOpen}>
              <CollapsibleTrigger className="w-full flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-lg hover:bg-[var(--interactive-hover)]/50 transition-colors group">
                <Icon name="terminal" className="h-3.5 w-3.5 text-muted-foreground/70" />
                <span className="typography-meta font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                  {t('multirun.launcher.setupCommands.label')}
                </span>
                {configuredSetupCount > 0 && (
                  <span
                    className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full typography-micro font-medium"
                    style={{
                      backgroundColor: 'var(--primary-base)',
                      color: 'var(--primary-foreground)',
                      fontSize: '0.625rem',
                      lineHeight: 1,
                    }}
                  >
                    {configuredSetupCount}
                  </span>
                )}
                <Icon name="arrow-down-s" className={cn(
                  'h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-200 ml-auto',
                  isSetupCommandsOpen && 'rotate-180',
                )} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-2 space-y-1.5">
                  {isLoadingSetupCommands ? (
                    <p className="typography-meta text-muted-foreground/70 px-2">{t('multirun.launcher.setupCommands.loading')}</p>
                  ) : (
                    <>
                      {setupCommands.map((command, index) => (
                        <div key={`${command}-${index}`} className="flex gap-1.5">
                          <Input
                            value={command}
                            onChange={(e) => {
                              const newCommands = [...setupCommands];
                              newCommands[index] = e.target.value;
                              setSetupCommands(newCommands);
                            }}
                            placeholder={t('multirun.launcher.setupCommands.commandPlaceholder')}
                            className="h-8 flex-1 font-mono text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => setSetupCommands(setupCommands.filter((_, i) => i !== index))}
                            className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                            aria-label={t('multirun.launcher.setupCommands.removeCommandAria')}
                          >
                            <Icon name="close" className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setSetupCommands([...setupCommands, ''])}
                        className="flex items-center gap-1 typography-meta text-muted-foreground hover:text-foreground transition-colors px-1"
                      >
                        <Icon name="add" className="h-3 w-3" />
                        {t('multirun.launcher.setupCommands.addCommand')}
                      </button>
                    </>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="prompt" required>{t('multirun.launcher.attachments.label')}</FieldLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} accept="*/*" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-md typography-micro text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50 transition-colors"
                    >
                      <Icon name="attachment-2" className="h-3 w-3" />
                      {t('multirun.launcher.attachments.attach')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('multirun.launcher.attachments.tooltip')}</TooltipContent>
                </Tooltip>
                {attachedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md typography-micro border"
                    style={{ backgroundColor: 'var(--surface-elevated)', borderColor: 'var(--interactive-border)' }}
                  >
                    {file.mimeType.startsWith('image/') ? (
                      <Icon name="file-image" className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <Icon name="file" className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="truncate max-w-[100px]" title={file.filename}>
                      {file.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(file.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {runGroups.map((group, groupIndex) => (
              <RunGroupCard
                key={group.id}
                group={group}
                groupIndex={groupIndex}
                templates={templates}
                canRemove={runGroups.length > 1}
                onUpdate={updateGroup}
                onRemove={removeGroup}
                onTemplateChange={handleTemplateChange}
              />
            ))}

            <button
              type="button"
              onClick={addGroup}
              className="flex items-center gap-1.5 py-2 px-3 -mx-3 rounded-lg typography-meta font-medium text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50 transition-colors"
            >
              <RiAddLine className="h-3.5 w-3.5" />
              {t('multirun.launcher.groups.addGroup')}
            </button>

            {error && (
              <div
                className="px-3 py-2 rounded-lg typography-meta"
                style={{
                  backgroundColor: 'var(--status-error-background)',
                  color: 'var(--status-error)',
                  borderWidth: 1,
                  borderColor: 'var(--status-error-border)',
                }}
              >
                {error}
              </div>
            )}
          </div>
        </div>
      </ScrollShadow>

      <div className="shrink-0 px-4 sm:px-6 py-3">
        <div className="mx-auto w-full max-w-2xl flex items-center justify-end gap-2">
          {!effectiveIsolateRuns && isGitRepository !== null ? (
            <div className="mr-auto flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
              <Icon name="information" className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('multirun.launcher.project.gitRequired')}</span>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            {t('multirun.launcher.actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!isValid || isSubmitting}>
            {isSubmitting ? (
              t('multirun.launcher.actions.creating')
            ) : (
              <>{t('multirun.launcher.actions.startWithRunCount', { count: totalRunCount })}</>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
};

interface RunGroupCardProps {
  group: RunGroupState;
  groupIndex: number;
  templates: { id: string; name: string; body: string; isDefault: boolean }[];
  canRemove: boolean;
  onUpdate: (groupId: string, updates: Partial<RunGroupState>) => void;
  onRemove: (groupId: string) => void;
  onTemplateChange: (groupId: string, templateId: string) => void;
}

const RunGroupCard: React.FC<RunGroupCardProps> = ({
  group,
  groupIndex,
  templates,
  canRemove,
  onUpdate,
  onRemove,
  onTemplateChange,
}) => {
  const { t } = useI18n();

  const handleAddModel = React.useCallback((model: ModelSelectionWithId) => {
    if (group.models.length >= MAX_MODELS_PER_GROUP) return;
    onUpdate(group.id, { models: [...group.models, model] });
  }, [group.id, group.models, onUpdate]);

  const handleRemoveModel = React.useCallback((index: number) => {
    onUpdate(group.id, { models: group.models.filter((_, i) => i !== index) });
  }, [group.id, group.models, onUpdate]);

  const handleUpdateModel = React.useCallback((index: number, model: ModelSelectionWithId) => {
    onUpdate(group.id, { models: group.models.map((item, i) => (i === index ? model : item)) });
  }, [group.id, group.models, onUpdate]);

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="typography-meta font-medium text-foreground">
          {t('multirun.launcher.groups.groupLabel', { index: groupIndex + 1 })}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={() => onRemove(group.id)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            aria-label={t('multirun.launcher.groups.removeGroup')}
          >
            <RiCloseLine className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel>{t('multirun.launcher.groups.template.label')}</FieldLabel>
        <Select
          value={group.templateId || '__custom__'}
          onValueChange={(v) => onTemplateChange(group.id, v === '__custom__' ? '' : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('multirun.launcher.groups.template.placeholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__custom__">{t('multirun.launcher.groups.template.custom')}</SelectItem>
            {templates.map((tpl) => (
              <SelectItem key={tpl.id} value={tpl.id}>{tpl.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel required>{t('multirun.launcher.groups.prompt.label')}</FieldLabel>
        <Textarea
          value={group.prompt}
          onChange={(e) => onUpdate(group.id, { prompt: e.target.value })}
          placeholder={t('multirun.launcher.groups.prompt.placeholder')}
          className="typography-meta min-h-[80px] max-h-[200px] resize-none overflow-y-auto field-sizing-content"
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          required
          info={<InfoTip>{t('multirun.launcher.models.info', { max: MAX_MODELS_PER_GROUP })}</InfoTip>}
        >
          {t('multirun.launcher.models.label')}
        </FieldLabel>
        <ModelMultiSelect
          selectedModels={group.models}
          onAdd={handleAddModel}
          onRemove={handleRemoveModel}
          onUpdate={handleUpdateModel}
          minModels={1}
          maxModels={MAX_MODELS_PER_GROUP}
        />
      </div>
    </div>
  );
};
