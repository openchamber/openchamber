import React from 'react';
import {
  RiAddCircleLine,
  RiAddLine,
  RiArrowDownSLine,
  RiCloseLine,
  RiFileImageLine,
  RiFileLine,
  RiGitBranchLine,
  RiHourglassFill,
  RiSendPlane2Line,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from '@/components/multirun/ModelMultiSelect';
import { BranchSelector, useBranchOptions } from '@/components/multirun/BranchSelector';
import { AgentSelector } from '@/components/multirun/AgentSelector';
import { CommandAutocomplete, type CommandAutocompleteHandle } from '@/components/chat/CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { isIMECompositionEvent } from '@/lib/ime';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ProjectRef } from '@/lib/openchamberConfig';
import type { CreateMultiRunParams, MultiRunFileAttachment } from '@/types/multirun';

/** Max file size in bytes (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Max number of concurrent runs */
const MAX_MODELS = 5;

/** Attached file for agent manager */
interface AttachedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface AgentManagerEmptyStateProps {
  className?: string;
  /** Called when the user submits to create a new agent group */
  onCreateGroup?: (params: CreateMultiRunParams) => Promise<void> | void;
  /** Indicates if a group creation is in progress */
  isCreating?: boolean;
}

export const AgentManagerEmptyState: React.FC<AgentManagerEmptyStateProps> = ({ 
  className,
  onCreateGroup,
  isCreating = false,
}) => {
  const [groupName, setGroupName] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [selectedModels, setSelectedModels] = React.useState<ModelSelectionWithId[]>([]);
  const [selectedAgent, setSelectedAgent] = React.useState<string>('');
  const [baseBranch, setBaseBranch] = React.useState('');
  const [attachedFiles, setAttachedFiles] = React.useState<AttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [isSetupCommandsOpen, setIsSetupCommandsOpen] = React.useState(false);
  const [isLoadingSetupCommands, setIsLoadingSetupCommands] = React.useState(false);
  const [showFileMention, setShowFileMention] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  
  const { currentTheme } = useThemeSystem();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const { isGitRepository, isLoading: isLoadingBranches } = useBranchOptions(currentDirectory);
  
  const vscodeWorkspaceFolder = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const folder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder;
    return typeof folder === 'string' && folder.trim().length > 0 ? folder.trim() : null;
  }, []);

  const isVSCodeRuntime = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    const apis = (window as unknown as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } } }).__OPENCHAMBER_RUNTIME_APIS__;
    return Boolean(apis?.runtime?.isVSCode);
  }, []);

  // Get project directory for setup commands
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const projectRef = React.useMemo<ProjectRef | null>(() => {
    // VS Code panel should always use the current workspace root.
    if (isVSCodeRuntime && vscodeWorkspaceFolder) {
      return { id: `vscode:${vscodeWorkspaceFolder}`, path: vscodeWorkspaceFolder };
    }

    if (activeProjectId) {
      const project = projects.find((p) => p.id === activeProjectId);
      if (project?.path) {
        return { id: project.id, path: project.path };
      }
    }

    if (currentDirectory) {
      return { id: `path:${currentDirectory}`, path: currentDirectory };
    }

    return null;
  }, [activeProjectId, projects, currentDirectory, vscodeWorkspaceFolder, isVSCodeRuntime]);

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

  const handleAddModel = React.useCallback((model: ModelSelectionWithId) => {
    if (selectedModels.length >= MAX_MODELS) {
      return;
    }
    setSelectedModels((prev) => [...prev, model]);
  }, [selectedModels.length]);

  const handleRemoveModel = React.useCallback((index: number) => {
    setSelectedModels((prev) => prev.filter((_, i) => i !== index));
  }, []);

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

        const newFile: AttachedFile = {
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

  const handleAutocompleteFileSelect = React.useCallback((file: { name: string; path: string; relativePath?: string }) => {
    const cursorPosition = textareaRef.current?.selectionStart ?? prompt.length;
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
      const currentTextarea = textareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [prompt, updateAutocompleteState]);

  const handleAutocompleteAgentSelect = React.useCallback((agentName: string) => {
    const cursorPosition = textareaRef.current?.selectionStart ?? prompt.length;
    const textBeforeCursor = prompt.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${prompt.substring(0, startIndex)}@${agentName} ${prompt.substring(cursorPosition)}`;
    const nextCursor = startIndex + agentName.length + 2;

    setPrompt(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = textareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [prompt, updateAutocompleteState]);

  const handleAutocompleteCommandSelect = React.useCallback((command: { name: string }) => {
    const nextPrompt = `/${command.name} `;
    setPrompt(nextPrompt);
    setShowCommandAutocomplete(false);
    setCommandQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = textareaRef.current;
      if (currentTextarea) {
        currentTextarea.focus();
        currentTextarea.selectionStart = currentTextarea.value.length;
        currentTextarea.selectionEnd = currentTextarea.value.length;
      }
      updateAutocompleteState(nextPrompt, nextPrompt.length);
    });
  }, [updateAutocompleteState]);

  // Use either local submitting state or external isCreating prop
  const isSubmittingOrCreating = isSubmitting || isCreating;

  const isValid = Boolean(
    groupName.trim() && 
    prompt.trim() && 
    selectedModels.length >= 1 && 
    baseBranch &&
    isGitRepository && 
    !isLoadingBranches
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!isValid || isSubmittingOrCreating) return;

    setIsSubmitting(true);

    try {
      const models = selectedModels.map(({ providerID, modelID, displayName, variant }) => ({
        providerID,
        modelID,
        displayName,
        variant,
      }));

      const files: MultiRunFileAttachment[] | undefined = attachedFiles.length > 0
        ? attachedFiles.map((f) => ({
            mime: f.mimeType,
            filename: f.filename,
            url: f.dataUrl,
          }))
        : undefined;

      // Filter setup commands
      const commandsToRun = setupCommands.filter(cmd => cmd.trim().length > 0);

      await onCreateGroup?.({
        name: groupName.trim(),
        prompt: prompt.trim(),
        models,
        agent: selectedAgent || undefined,
        worktreeBaseBranch: baseBranch,
        files,
        setupCommands: commandsToRun.length > 0 ? commandsToRun : undefined,
      });

      // Reset form on success - only after onCreateGroup completes
      setGroupName('');
      setPrompt('');
      setSelectedModels([]);
      setSelectedAgent('');
      setAttachedFiles([]);
      setBaseBranch('HEAD');
      setShowCommandAutocomplete(false);
      setShowFileMention(false);
      setCommandQuery('');
      setMentionQuery('');
    } catch (error) {
      console.error('Failed to create agent group:', error);
      toast.error('Failed to create agent group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Early return during IME composition
    if (isIMECompositionEvent(e)) return;

    if (showCommandAutocomplete && commandRef.current) {
      if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        commandRef.current.handleKeyDown(e.key);
        return;
      }
    }

    if (showFileMention && mentionRef.current) {
      if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        mentionRef.current.handleKeyDown(e.key);
        return;
      }
    }

    // Enter submits if valid, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isValid && !isSubmittingOrCreating) {
        handleSubmit(e as unknown as React.FormEvent);
      }
      // If not valid, do nothing (no newline, no submit)
    }
    // Shift+Enter: default textarea behavior (adds newline)
  };

  return (
    <div className={cn('flex flex-col items-center justify-center h-full w-full p-4', className)}>
      <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-4">
        {/* Group Name Input */}
        <div className="space-y-1.5">
          <label htmlFor="group-name" className="typography-ui-label font-medium text-foreground">
            Group Name
          </label>
          <Input
            id="group-name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. feature-auth, bugfix-login"
            className="typography-body"
          />
          <p className="typography-micro text-muted-foreground">
            Used for worktree directory and branch naming
          </p>
        </div>

        {/* Branch Selection */}
        <div className="space-y-1.5">
          <label className="typography-ui-label font-medium text-foreground flex items-center gap-1.5">
            <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
            Base Branch
          </label>
          <BranchSelector
            directory={currentDirectory}
            value={baseBranch}
            onChange={setBaseBranch}
          />
          <p className="typography-micro text-muted-foreground">
            Creates new branches from <code className="font-mono text-xs">{baseBranch}</code>
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

        {/* Agent Selection */}
        <div className="space-y-1.5">
          <label className="typography-ui-label font-medium text-foreground">
            Agent
          </label>
          <AgentSelector
            value={selectedAgent}
            onChange={setSelectedAgent}
          />
          <p className="typography-micro text-muted-foreground">
            Defaults to your configured default agent
          </p>
        </div>

        {/* Model Selection */}
        <div className="space-y-1.5">
          <label className="typography-ui-label font-medium text-foreground">
            Models
          </label>
          <ModelMultiSelect
            selectedModels={selectedModels}
            onAdd={handleAddModel}
            onRemove={handleRemoveModel}
            onUpdate={handleUpdateModel}
            minModels={1}
            addButtonLabel="Add model"
            maxModels={5}
          />
        </div>

        {/* Chat Input Style Prompt */}
        <div className="space-y-1.5">
          <label htmlFor="prompt" className="typography-ui-label font-medium text-foreground">
            Prompt
          </label>
          <div className="relative">
            <div
              className="rounded-xl border border-border/80 overflow-hidden focus-within:ring-1 focus-within:ring-primary/50"
              style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
            >
              {/* Text Area */}
              <Textarea
                ref={textareaRef}
                id="prompt"
                value={prompt}
                onChange={(event) => {
                  const nextPrompt = event.target.value;
                  setPrompt(nextPrompt);
                  const cursorPosition = event.target.selectionStart ?? nextPrompt.length;
                  updateAutocompleteState(nextPrompt, cursorPosition);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything..."
                className="min-h-[100px] max-h-[300px] resize-none border-0 bg-transparent dark:bg-transparent px-4 py-3 typography-markdown focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            
            {/* Attached Files Display */}
            {attachedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pb-2">
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
            )}
            
              {/* Footer Controls */}
              <div className="flex items-center justify-between px-3 py-2 border-t border-border/40 bg-transparent">
              {/* Left Controls - Attachments */}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                  accept="*/*"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Add attachment"
                >
                  <RiAddCircleLine className="h-[18px] w-[18px]" />
                </button>
              </div>
              
              {/* Right Controls - Model Count */}
              <div className="flex items-center gap-2">
                <span className="typography-meta text-muted-foreground">
                  {selectedModels.length} model{selectedModels.length !== 1 ? 's' : ''} selected
                </span>
              </div>
              {/* Submit Button */}
               <button
                  type="submit"
                  disabled={!isValid || isSubmittingOrCreating}
                  className={cn(
                      'flex items-center justify-center text-muted-foreground transition-none outline-none focus:outline-none flex-shrink-0',
                      isValid
                          ? 'text-primary hover:text-primary'
                          : 'opacity-30'
                  )}
                  aria-label="Start Agent Group"
                >
                  {isSubmittingOrCreating ? (
                    <RiHourglassFill className="h-[18px] w-[18px] animate-spin" />
                  ) : (
                    <RiSendPlane2Line className="h-[18px] w-[18px]" />
                  )}
                </button>
              </div>
            </div>

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
        </div>
      </form>
    </div>
  );
};
