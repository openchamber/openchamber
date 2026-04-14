import React from 'react';
import { RiAddLine, RiArrowDownSLine, RiAttachment2, RiCloseLine, RiFileImageLine, RiFileLine, RiFolderLine, RiInformationLine, RiTerminalLine } from '@remixicon/react';
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
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import type { ProjectEntry } from '@/lib/api/types';

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
  <Tooltip delayDuration={200}>
    <TooltipTrigger asChild>
      <button type="button" tabIndex={-1} className="inline-flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground transition-colors">
        <RiInformationLine className="h-3.5 w-3.5" />
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
  const [name, setName] = React.useState('');
  const [prompt, setPrompt] = React.useState(() => initialPrompt ?? '');
  const [selectedModels, setSelectedModels] = React.useState<ModelSelectionWithId[]>([]);
  const [selectedAgent, setSelectedAgent] = React.useState<string>('');
  const [attachedFiles, setAttachedFiles] = React.useState<MultiRunAttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [isSetupCommandsOpen, setIsSetupCommandsOpen] = React.useState(false);
  const [isLoadingSetupCommands, setIsLoadingSetupCommands] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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
    const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
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
        ) : ProjectIcon ? (
          <ProjectIcon className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
        ) : (
          <RiFolderLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
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
    if (isDesktopApp && isMacPlatform) {
      // Match main app header: reserve space for Mac traffic lights.
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
  }, [isDesktopApp, isMacPlatform]);

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
        toast.error(`File "${file.name}" is too large (max 10MB)`);
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
        toast.error(`Failed to attach "${file.name}"`);
      }
    }

    if (attachedCount > 0) {
      toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

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
    name.trim() && prompt.trim() && selectedModels.length >= 2 && worktreeBaseBranch && isGitRepository && !isLoadingWorktreeBaseBranches
  );

  const configuredSetupCount = setupCommands.filter(cmd => cmd.trim()).length;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full bg-background" data-keyboard-avoid="true">
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
          <h1 className="typography-ui-label font-medium">New Multi-Run</h1>
          {onCancel && (
            <div className="absolute right-0 flex items-center pr-3">
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Close (Esc)"
                    className="inline-flex h-9 w-9 items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary app-region-no-drag"
                  >
                    <RiCloseLine className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Close (Esc)</p>
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
                <FieldLabel htmlFor="multirun-project" required>Project</FieldLabel>
                {projects.length > 0 ? (
                  <Select
                    value={selectedProjectId ?? undefined}
                    onValueChange={handleProjectChange}
                  >
                    <SelectTrigger id="multirun-project" size="lg" className="w-fit max-w-full">
                      {selectedProject ? (
                        <SelectValue>{renderProjectLabel(selectedProject)}</SelectValue>
                      ) : (
                        <SelectValue placeholder="Select project" />
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
                  <p className="typography-micro text-muted-foreground py-2">Add a project first.</p>
                )}
              </div>

              {/* Group name */}
              <div className="flex flex-col gap-1">
                <FieldLabel
                  htmlFor="group-name"
                  required
                  info={<InfoTip>Used for worktree directory and branch names</InfoTip>}
                >
                  Group name
                </FieldLabel>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="feature-auth, bugfix-login"
                  className="typography-meta w-full"
                  required
                />
              </div>

              {/* Base branch */}
              <div className="flex flex-col gap-1">
                <FieldLabel
                  htmlFor="multirun-worktree-base-branch"
                  info={<InfoTip>New branch created from this base per model</InfoTip>}
                >
                  Base branch
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
                  info={<InfoTip>Agent used for all runs. Defaults to your configured agent.</InfoTip>}
                >
                  Agent
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
                <RiTerminalLine className="h-3.5 w-3.5 text-muted-foreground/70" />
                <span className="typography-meta font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                  Setup commands
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
                <RiArrowDownSLine className={cn(
                  'h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-200 ml-auto',
                  isSetupCommandsOpen && 'rotate-180'
                )} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-2 space-y-1.5">
                  {isLoadingSetupCommands ? (
                    <p className="typography-meta text-muted-foreground/70 px-2">Loading...</p>
                  ) : (
                    <>
                      {setupCommands.map((command, index) => (
                        <div key={index} className="flex gap-1.5">
                          <Input
                            value={command}
                            onChange={(e) => {
                              const newCommands = [...setupCommands];
                              newCommands[index] = e.target.value;
                              setSetupCommands(newCommands);
                            }}
                            placeholder="bun install"
                            className="h-8 flex-1 font-mono text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const newCommands = setupCommands.filter((_, i) => i !== index);
                              setSetupCommands(newCommands);
                            }}
                            className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                            aria-label="Remove command"
                          >
                            <RiCloseLine className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setSetupCommands([...setupCommands, ''])}
                        className="flex items-center gap-1 typography-meta text-muted-foreground hover:text-foreground transition-colors px-1"
                      >
                        <RiAddLine className="h-3 w-3" />
                        Add command
                      </button>
                    </>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* ── Prompt ── */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="prompt" required>Prompt</FieldLabel>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter the prompt to send to all models..."
                className="typography-meta min-h-[100px] max-h-[300px] resize-none overflow-y-auto field-sizing-content"
                required
              />

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
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-md typography-micro text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50 transition-colors"
                    >
                      <RiAttachment2 className="h-3 w-3" />
                      Attach
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Same files sent to all runs</TooltipContent>
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
                      <RiFileImageLine className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <RiFileLine className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="truncate max-w-[100px]" title={file.filename}>
                      {file.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(file.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <RiCloseLine className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Models ── */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                required
                info={<InfoTip>Select 2–{MAX_MODELS} models. Same model can be added multiple times.</InfoTip>}
              >
                Models
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? (
              'Creating...'
            ) : (
              <>Start ({selectedModels.length} models)</>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
};
