import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
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
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import type { ProjectRef } from '@/lib/openchamberConfig';
import type { CreateMultiRunParams, MultiRunModelSelection } from '@/types/multirun';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';
import { BranchSelector, useBranchOptions } from './BranchSelector';
import { AgentSelector } from './AgentSelector';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { Icon } from "@/components/icon/Icon";
import { isDesktopShell } from '@/lib/desktop';
import { useTabletStandalonePwaRuntime } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import type { ProjectEntry } from '@/lib/api/types';
import { startDesktopWindowDrag } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';

/** Max file size in bytes (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Max number of concurrent runs */
const MAX_MODELS = 5;

/** Attached file for multi-run (simplified from sessionStore's AttachedFile) */
interface MultiRunAttachedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface MultiRunLauncherProps {
  /** Prefill prompt textarea (optional) */
  initialPrompt?: string;
  /** Called when multi-run is successfully created */
  onCreated?: () => void;
  /** Called when user cancels */
  onCancel?: () => void;
  /** Rendered inside dialog window with no local header */
  isWindowed?: boolean;
}

/** Info tooltip - small icon that shows helper text on hover */
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

/** Compact field label */
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

/**
 * Launcher form for creating a new Multi-Run group.
 * Compact, centered card layout with adaptive grid.
 */
export const MultiRunLauncher: React.FC<MultiRunLauncherProps> = ({
  initialPrompt,
  onCreated,
  onCancel,
  isWindowed = false,
}) => {
  const { t } = useI18n();
  const [name, setName] = React.useState('');
  const [prompt, setPrompt] = React.useState(() => initialPrompt ?? '');
  const [selectedModels, setSelectedModels] = React.useState<ModelSelectionWithId[]>([]);
  const [selectedAgent, setSelectedAgent] = React.useState<string>('');
  const [attachedFiles, setAttachedFiles] = React.useState<MultiRunAttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [isSetupCommandsOpen, setIsSetupCommandsOpen] = React.useState(false);
  const [isLoadingSetupCommands, setIsLoadingSetupCommands] = React.useState(false);
  const [showFileMention, setShowFileMention] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const promptTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory ?? null);
  
  const vscodeWorkspaceFolder = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const folder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder;
    return typeof folder === 'string' && folder.trim().length > 0 ? folder.trim() : null;
  }, []);

  // Get project directory for setup commands
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
    if (!selectedProjectId) {
      return null;
    }
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
    if (!base) {
      return null;
    }

    return { id: `path:${base}`, path: base };
  }, [selectedProject, currentDirectory, vscodeWorkspaceFolder]);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
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
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  // Handle ESC key to dismiss
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

  // Use the BranchSelector hook for branch state management
  const [worktreeBaseBranch, setWorktreeBaseBranch] = React.useState<string>('');
  const { isLoading: isLoadingWorktreeBaseBranches, isGitRepository } = useBranchOptions(selectedProjectDirectory);

  const createMultiRun = useMultiRunStore((state) => state.createMultiRun);
  const error = useMultiRunStore((state) => state.error);
  const clearError = useMultiRunStore((state) => state.clearError);

  React.useEffect(() => {
    if (typeof initialPrompt === 'string' && initialPrompt.trim().length > 0) {
      setPrompt((prev) => (prev.trim().length > 0 ? prev : initialPrompt));
    }
  }, [initialPrompt]);

  // Load setup commands from config
  React.useEffect(() => {
    if (!projectRef) return;
    
    let cancelled = false;
    setIsLoadingSetupCommands(true);
    
    (async () => {
      try {
        const commands = await getWorktreeSetupCommands(projectRef);
        if (!cancelled) {
          setSetupCommands(commands);
        }
      } catch {
        // Ignore errors, start with empty commands
      } finally {
        if (!cancelled) {
          setIsLoadingSetupCommands(false);
        }
      }
    })();
    
    return () => { cancelled = true; };
  }, [projectRef]);

  const handleAddModel = (model: ModelSelectionWithId) => {
    if (selectedModels.length >= MAX_MODELS) {
      return;
    }
    setSelectedModels((prev) => [...prev, model]);
    clearError();
  };

  const handleRemoveModel = (index: number) => {
    setSelectedModels((prev) => prev.filter((_, i) => i !== index));
    clearError();
  };

  const handleUpdateModel = React.useCallback((index: number, model: ModelSelectionWithId) => {
    setSelectedModels((prev) => prev.map((item, i) => (i === index ? model : item)));
  }, []);

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

        const newFile: MultiRunAttachedFile = {
          id: generateInstanceId(),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl,
        };

        setAttachedFiles((prev) => [...prev, newFile]);
        attachedCount++;
      } catch (error) {
        console.error('File attach failed', error);
        toast.error(t('multirun.launcher.toast.attachFailed', { fileName: file.name }));
      }
    }

    if (attachedCount > 0) {
      toast.success(
        attachedCount === 1
          ? t('multirun.launcher.toast.attachedSingle', { count: attachedCount })
          : t('multirun.launcher.toast.attachedPlural', { count: attachedCount })
      );
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
    if (value.startsWith('/')) {
      const firstSpace = value.indexOf(' ');
      const firstNewline = value.indexOf('\n');
      const commandEnd = Math.min(
        firstSpace === -1 ? value.length : firstSpace,
        firstNewline === -1 ? value.length : firstNewline,
      );

      if (cursorPosition <= commandEnd && firstSpace === -1) {
        setCommandQuery(value.substring(1, commandEnd));
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        return;
      }
    }

    setShowCommandAutocomplete(false);

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol !== -1) {
      const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
      const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
      const isWordBoundary = !charBefore || /\s/.test(charBefore);
      if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
        setMentionQuery(textAfterAt);
        setShowFileMention(true);
      } else {
        setShowFileMention(false);
      }
      return;
    }

    setShowFileMention(false);
  }, []);

  const handlePromptKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandAutocomplete && commandRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        commandRef.current.handleKeyDown(event.key);
        return;
      }
    }

    if (showFileMention && mentionRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        mentionRef.current.handleKeyDown(event.key);
      }
    }
  }, [showCommandAutocomplete, showFileMention]);

  const handleAutocompleteFileSelect = React.useCallback((file: { name: string; path: string; relativePath?: string }) => {
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? prompt.length;
    const textBeforeCursor = prompt.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
      ? file.relativePath.trim()
      : (file.path || file.name);

    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${prompt.substring(0, startIndex)}@${mentionPath} ${prompt.substring(cursorPosition)}`;
    const nextCursor = startIndex + mentionPath.length + 2;

    setPrompt(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [prompt, updateAutocompleteState]);

  const handleAutocompleteAgentSelect = React.useCallback((agentName: string) => {
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? prompt.length;
    const textBeforeCursor = prompt.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${prompt.substring(0, startIndex)}@${agentName} ${prompt.substring(cursorPosition)}`;
    const nextCursor = startIndex + agentName.length + 2;

    setPrompt(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [prompt, updateAutocompleteState]);

  const handleAutocompleteCommandSelect = React.useCallback((command: CommandInfo) => {
    const nextPrompt = `/${command.name} `;
    setPrompt(nextPrompt);
    setShowCommandAutocomplete(false);
    setCommandQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.focus();
        currentTextarea.selectionStart = currentTextarea.value.length;
        currentTextarea.selectionEnd = currentTextarea.value.length;
      }
      updateAutocompleteState(nextPrompt, nextPrompt.length);
    });
  }, [updateAutocompleteState]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!prompt.trim()) {
      return;
    }
    if (selectedModels.length < 2) {
      return;
    }

    setIsSubmitting(true);
    clearError();

    try {
      if (selectedProjectId && selectedProjectId !== activeProjectId) {
        setActiveProjectIdOnly(selectedProjectId);
      }

      // Strip instanceId before passing to store (UI-only field)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const modelsForStore: MultiRunModelSelection[] = selectedModels.map(({ instanceId: _instanceId, ...rest }) => rest);
      
      // Convert attached files to the format expected by the store
      const filesForStore = attachedFiles.map((f) => ({
        mime: f.mimeType,
        filename: f.filename,
        url: f.dataUrl,
      }));

      // Filter setup commands
      const commandsForStore = setupCommands.filter(cmd => cmd.trim().length > 0);

      const params: CreateMultiRunParams = {
        name: name.trim(),
        prompt: prompt.trim(),
        models: modelsForStore,
        agent: selectedAgent || undefined,
        worktreeBaseBranch,
        files: filesForStore.length > 0 ? filesForStore : undefined,
        setupCommands: commandsForStore.length > 0 ? commandsForStore : undefined,
      };

      const result = await createMultiRun(params);
       if (result) {
         if (result.firstSessionId) {
           useSessionUIStore.getState().setCurrentSession(result.firstSessionId);
         }

         // Close launcher
         onCreated?.();
       }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = Boolean(
    name.trim() &&
    prompt.trim() &&
    selectedModels.length >= 2 &&
    selectedProjectDirectory &&
    !isLoadingWorktreeBaseBranches &&
    (isGitRepository === false || (isGitRepository === true && worktreeBaseBranch))
  );

  const configuredSetupCount = setupCommands.filter(cmd => cmd.trim()).length;

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
                <TooltipContent>
                  <p>{t('multirun.launcher.actions.closeEsc')}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </header>
      ) : null}

      {/* Scrollable content */}
      <ScrollShadow className="flex-1 min-h-0 overflow-auto" size={64} hideTopShadow>
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-5">
          <div className="flex flex-col gap-5">

            {/* ── Config grid: 2-column on sm+, single column on narrow ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              {/* Project */}
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="multirun-project" required>{t('multirun.launcher.project.label')}</FieldLabel>
                {projects.length > 0 ? (
                  <Select
                    value={selectedProjectId ?? undefined}
                    onValueChange={handleProjectChange}
                  >
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

              {/* Group name */}
              <div className="flex flex-col gap-1">
                <FieldLabel
                  htmlFor="group-name"
                  required
                  info={<InfoTip>{t('multirun.launcher.groupName.info')}</InfoTip>}
                >
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

              {/* Base branch */}
              <div className="flex flex-col gap-1">
                <FieldLabel
                  htmlFor="multirun-worktree-base-branch"
                  info={<InfoTip>{t('multirun.launcher.baseBranch.info')}</InfoTip>}
                >
                  {t('multirun.launcher.baseBranch.label')}
                </FieldLabel>
                <BranchSelector
                  directory={selectedProjectDirectory}
                  value={worktreeBaseBranch}
                  onChange={setWorktreeBaseBranch}
                  id="multirun-worktree-base-branch"
                />
              </div>

              {/* Agent */}
              <div className="flex flex-col gap-1">
                <FieldLabel
                  htmlFor="multirun-agent"
                  info={<InfoTip>{t('multirun.launcher.agent.info')}</InfoTip>}
                >
                  {t('multirun.launcher.agent.label')}
                </FieldLabel>
                <AgentSelector
                  value={selectedAgent}
                  onChange={setSelectedAgent}
                  id="multirun-agent"
                />
              </div>
            </div>

            {/* ── Setup commands (collapsible, full width) ── */}
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
                  isSetupCommandsOpen && 'rotate-180'
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
                            onClick={() => {
                              const newCommands = setupCommands.filter((_, i) => i !== index);
                              setSetupCommands(newCommands);
                            }}
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

            {/* ── Prompt ── */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="prompt" required>{t('multirun.launcher.prompt.label')}</FieldLabel>
              <div className="relative">
                <Textarea
                  id="prompt"
                  ref={promptTextareaRef}
                  value={prompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    setPrompt(nextPrompt);
                    const cursorPosition = event.target.selectionStart ?? nextPrompt.length;
                    updateAutocompleteState(nextPrompt, cursorPosition);
                  }}
                  onKeyDown={handlePromptKeyDown}
                  placeholder={t('multirun.launcher.prompt.placeholder')}
                  className="typography-meta min-h-[100px] max-h-[300px] resize-none overflow-y-auto field-sizing-content"
                  required
                />

                {showCommandAutocomplete ? (
                  <CommandAutocomplete
                    ref={commandRef}
                    searchQuery={commandQuery}
                    onCommandSelect={handleAutocompleteCommandSelect}
                    onClose={() => setShowCommandAutocomplete(false)}
                    style={{
                      left: 0,
                      top: 'auto',
                      bottom: 'calc(100% + 6px)',
                      marginBottom: 0,
                      maxWidth: '100%',
                    }}
                  />
                ) : null}

                {showFileMention ? (
                  <FileMentionAutocomplete
                    ref={mentionRef}
                    searchQuery={mentionQuery}
                    onFileSelect={handleAutocompleteFileSelect}
                    onAgentSelect={handleAutocompleteAgentSelect}
                    onClose={() => setShowFileMention(false)}
                    style={{
                      left: 0,
                      top: 'auto',
                      bottom: 'calc(100% + 6px)',
                      marginBottom: 0,
                      maxWidth: '100%',
                    }}
                  />
                ) : null}
              </div>

              {/* File attachments inline */}
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                  accept="*/*"
                />
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
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      borderColor: 'var(--interactive-border)',
                    }}
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

            {/* ── Models ── */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                required
                info={<InfoTip>{t('multirun.launcher.models.info', { max: MAX_MODELS })}</InfoTip>}
              >
                {t('multirun.launcher.models.label')}
              </FieldLabel>
              <ModelMultiSelect
                selectedModels={selectedModels}
                onAdd={handleAddModel}
                onRemove={handleRemoveModel}
                onUpdate={handleUpdateModel}
                minModels={2}
                maxModels={MAX_MODELS}
              />
            </div>

            {/* ── Error ── */}
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

      {/* ── Fixed footer ── */}
      <div className="shrink-0 px-4 sm:px-6 py-3">
        <div className="mx-auto w-full max-w-2xl flex items-center justify-end gap-2">
          {isGitRepository === false ? (
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
          <Button
            type="submit"
            size="sm"
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? (
              t('multirun.launcher.actions.creating')
            ) : (
              <>{t('multirun.launcher.actions.startWithModelCount', { count: selectedModels.length })}</>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
};
