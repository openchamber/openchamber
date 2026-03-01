import React from 'react';
import { RiAddLine, RiArrowDownSLine, RiAttachment2, RiCloseLine, RiFileImageLine, RiFileLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import type { ProjectRef } from '@/lib/openchamberConfig';
import type { CreateMultiRunParams, MultiRunModelSelection } from '@/types/multirun';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';
import { BranchSelector, useBranchOptions } from './BranchSelector';
import { AgentSelector } from './AgentSelector';
import { isDesktopShell } from '@/lib/desktop';

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
}

/**
 * Launcher form for creating a new Multi-Run group.
 * Replaces the main content area (tabs) with a form.
 */
export const MultiRunLauncher: React.FC<MultiRunLauncherProps> = ({
  initialPrompt,
  onCreated,
  onCancel,
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
  
  const vscodeWorkspaceFolder = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const folder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder;
    return typeof folder === 'string' && folder.trim().length > 0 ? folder.trim() : null;
  }, []);

  // Get project directory for setup commands
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const projectRef = React.useMemo<ProjectRef | null>(() => {
    if (activeProjectId) {
      const project = projects.find((p) => p.id === activeProjectId);
      if (project?.path) {
        return { id: project.id, path: project.path };
      }
    }

    const base = currentDirectory ?? vscodeWorkspaceFolder;
    if (!base) {
      return null;
    }

    return { id: `path:${base}`, path: base };
  }, [activeProjectId, projects, currentDirectory, vscodeWorkspaceFolder]);

  const isDesktopApp = isDesktopShell();

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
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
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        await window.startDragging();
      } catch {
        // ignore
      }
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
  const [worktreeBaseBranch, setWorktreeBaseBranch] = React.useState<string>('HEAD');
  const { isLoading: isLoadingWorktreeBaseBranches, isGitRepository } = useBranchOptions(currentDirectory);

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
           useSessionStore.getState().setCurrentSession(result.firstSessionId);
         }

         // Close launcher
         onCreated?.();
       }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = Boolean(
    name.trim() && prompt.trim() && selectedModels.length >= 2 && isGitRepository && !isLoadingWorktreeBaseBranches
  );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header - same height as app header (h-12 = 48px) */}
      <header
        onMouseDown={handleDragStart}
        className={cn(
          'relative flex h-12 items-center justify-center border-b app-region-drag select-none',
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

      {/* Content with chat-column max-width */}
      <div className="flex-1 overflow-auto">
        <div className="chat-column py-6">
          <form onSubmit={handleSubmit} className="space-y-6" data-keyboard-avoid="true">
            {/* Group name (required) */}
            <div className="space-y-2">
              <label htmlFor="group-name" className="typography-ui-label font-medium text-foreground">
                Group name <span className="text-destructive">*</span>
              </label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. feature-auth, bugfix-login"
                className="typography-body max-w-full sm:max-w-xs"
                required
              />
              <p className="typography-micro text-muted-foreground">
                Used for worktree directory and branch names
              </p>
            </div>

            {/* Worktree creation */}
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="typography-ui-label font-medium text-foreground">Worktrees</p>
                <p className="typography-micro text-muted-foreground">
                  Create one worktree per model by creating a new branch from a base branch.
                </p>
              </div>

              <div className="space-y-2">
                <label
                  className="typography-meta font-medium text-foreground"
                  htmlFor="multirun-worktree-base-branch"
                >
                  Base branch
                </label>
                <BranchSelector
                  directory={currentDirectory}
                  value={worktreeBaseBranch}
                  onChange={setWorktreeBaseBranch}
                  id="multirun-worktree-base-branch"
                />
                <p className="typography-micro text-muted-foreground">
                  Creates new branches from{' '}
                  <code className="font-mono text-xs text-muted-foreground">{worktreeBaseBranch || 'HEAD'}</code>.
                </p>
              </div>

              {/* Setup commands collapsible */}
              <Collapsible open={isSetupCommandsOpen} onOpenChange={setIsSetupCommandsOpen}>
                <CollapsibleTrigger className="w-full flex items-center justify-between py-1 hover:bg-[var(--interactive-hover)] rounded-md px-1 -mx-1 transition-colors">
                  <p className="typography-ui-label font-medium text-foreground">
                    Setup commands
                    {setupCommands.filter(cmd => cmd.trim()).length > 0 && (
                      <span className="font-normal text-muted-foreground/70">
                        {' '}({setupCommands.filter(cmd => cmd.trim()).length} configured)
                      </span>
                    )}
                  </p>
                  <RiArrowDownSLine className={cn(
                    'h-4 w-4 text-muted-foreground transition-transform duration-200',
                    isSetupCommandsOpen && 'rotate-180'
                  )} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-2 space-y-2">
                    <p className="typography-micro text-muted-foreground/70">
                      Commands run in each new worktree. Use <code className="font-mono text-xs">$ROOT_PROJECT_PATH</code> for project root.
                    </p>
                    {isLoadingSetupCommands ? (
                      <p className="typography-meta text-muted-foreground/70">Loading...</p>
                    ) : (
                      <div className="space-y-1.5">
                        {setupCommands.map((command, index) => (
                          <div key={index} className="flex gap-2">
                            <Input
                              value={command}
                              onChange={(e) => {
                                const newCommands = [...setupCommands];
                                newCommands[index] = e.target.value;
                                setSetupCommands(newCommands);
                              }}
                              placeholder="e.g., bun install"
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
                              <RiCloseLine className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setSetupCommands([...setupCommands, ''])}
                          className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <RiAddLine className="h-3.5 w-3.5" />
                          Add command
                        </button>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>

            {/* Agent selection */}
            <div className="space-y-2">
              <label
                className="typography-ui-label font-medium text-foreground"
                htmlFor="multirun-agent"
              >
                Agent
              </label>
              <AgentSelector
                value={selectedAgent}
                onChange={setSelectedAgent}
                id="multirun-agent"
              />
              <p className="typography-micro text-muted-foreground">
                Defaults to your configured default agent.
              </p>
            </div>

            {/* Prompt */}
            <div className="space-y-2">
              <label htmlFor="prompt" className="typography-ui-label font-medium text-foreground">
                Prompt <span className="text-destructive">*</span>
              </label>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter the prompt to send to all models..."
                className="typography-body min-h-[120px] max-h-[400px] resize-none overflow-y-auto field-sizing-content"
                required
              />
            </div>

            {/* File attachments */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="typography-ui-label font-medium text-foreground">
                  Attachments
                </label>
                <span className="typography-micro text-muted-foreground">(optional, same files for all runs)</span>
              </div>
              
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
                accept="*/*"
              />
              
              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <RiAttachment2 className="h-3.5 w-3.5 mr-1.5" />
                  Attach files
                </Button>
                
                {attachedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted/30 border border-border/30 rounded-md typography-meta"
                  >
                    {file.mimeType.startsWith('image/') ? (
                      <RiFileImageLine className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <RiFileLine className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="truncate max-w-[120px]" title={file.filename}>
                      {file.filename}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      ({file.size < 1024 ? `${file.size}B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)}KB` : `${(file.size / (1024 * 1024)).toFixed(1)}MB`})
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(file.id)}
                      className="text-muted-foreground hover:text-destructive ml-0.5"
                    >
                      <RiCloseLine className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Model selection */}
            <div className="space-y-2">
              <label className="typography-ui-label font-medium text-foreground">
                Models <span className="text-destructive">*</span>
              </label>
              <ModelMultiSelect
                selectedModels={selectedModels}
                onAdd={handleAddModel}
                onRemove={handleRemoveModel}
                onUpdate={handleUpdateModel}
                minModels={2}
                maxModels={MAX_MODELS}
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive typography-body">
                {error}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!isValid || isSubmitting}
              >
                {isSubmitting ? (
                  'Creating...'
                ) : (
                  <>
                    Start ({selectedModels.length} models)
                  </>
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
