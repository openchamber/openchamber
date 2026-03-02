import React from 'react';
import { RiCloseLine, RiUploadLine, RiFileTextLine, RiFolderLine, RiArrowRightSLine, RiArrowLeftSLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';
import { validateWorkpackageFile, type WorkpackageFile } from '@/types/agentloop';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/multirun/AgentSelector';
import { opencodeClient } from '@/lib/opencode/client';
import type { FilesystemEntry } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

type LauncherStep = 'choose-source' | 'browse-files' | 'select-file' | 'configure';

interface AgentLoopLauncherPrefill {
  workpackageFile: WorkpackageFile;
  providerID?: string;
  modelID?: string;
  agent?: string;
}

interface AgentLoopLauncherProps {
  onCreated?: () => void;
  onCancel?: () => void;
  prefill?: AgentLoopLauncherPrefill | null;
}

/**
 * Launcher form for starting a new Agent Loop.
 * Step 1: Choose whether to browse for an existing workpackage file or describe a new one.
 * Step 2a (browse): In-app file browser — navigate and pick a .json file.
 * Step 2b (generate): Describe the goal, pick a model, generate the plan.
 * Step 3: Configure model, agent, and prompt then start the loop.
 */
export const AgentLoopLauncher: React.FC<AgentLoopLauncherProps> = ({
  onCreated,
  onCancel,
  prefill,
}) => {
  const [step, setStep] = React.useState<LauncherStep>(prefill?.workpackageFile ? 'configure' : 'choose-source');
  const [workpackageFile, setWorkpackageFile] = React.useState<WorkpackageFile | null>(prefill?.workpackageFile ?? null);
  const [systemPrompt, setSystemPrompt] = React.useState('');
  const [selectedProviderId, setSelectedProviderId] = React.useState(prefill?.providerID ?? '');
  const [selectedModelId, setSelectedModelId] = React.useState(prefill?.modelID ?? '');
  const [selectedVariant, setSelectedVariant] = React.useState<string | undefined>(undefined);
  const [selectedAgent, setSelectedAgent] = React.useState(prefill?.agent ?? '');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [generatePrompt, setGeneratePrompt] = React.useState('');

  // In-app file browser state
  const [browserPath, setBrowserPath] = React.useState<string | null>(null);
  const [browserEntries, setBrowserEntries] = React.useState<FilesystemEntry[]>([]);
  const [browserLoading, setBrowserLoading] = React.useState(false);
  const [browserError, setBrowserError] = React.useState<string | null>(null);

  // System file picker fallback
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const currentProviderId = useConfigStore((s) => s.currentProviderId);
  const currentModelId = useConfigStore((s) => s.currentModelId);
  const providers = useConfigStore((s) => s.providers);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const { startLoop, isCreating, error: loopError } = useAgentLoopStore();

  // Compute available variants for the currently selected model
  const availableVariants = React.useMemo(() => {
    if (!selectedProviderId || !selectedModelId) return [];
    const provider = providers.find((p) => p.id === selectedProviderId);
    if (!provider) return [];
    const model = provider.models.find((m) => m.id === selectedModelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
  }, [providers, selectedProviderId, selectedModelId]);
  const startPlanningSession = useAgentLoopStore((s) => s.startPlanningSession);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);

  // Default to current model, or pre-fill from workpackage file's saved config
  React.useEffect(() => {
    if (!selectedProviderId && currentProviderId) setSelectedProviderId(currentProviderId);
    if (!selectedModelId && currentModelId) setSelectedModelId(currentModelId);
  }, [currentProviderId, currentModelId, selectedProviderId, selectedModelId]);

  // Pre-fill model config from workpackage file when one is loaded
  React.useEffect(() => {
    if (!workpackageFile?.modelConfig) return;
    const cfg = workpackageFile.modelConfig;
    if (cfg.providerID) setSelectedProviderId(cfg.providerID);
    if (cfg.modelID) setSelectedModelId(cfg.modelID);
    if (cfg.variant) setSelectedVariant(cfg.variant);
  }, [workpackageFile]);

  // Load directory entries when entering or navigating the browser
  const loadBrowserDir = React.useCallback(async (path: string | null) => {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const target = path ?? currentDirectory ?? null;
      const entries = await opencodeClient.listLocalDirectory(target);
      // Dirs first (non-hidden), then .json files
      const dirs = entries
        .filter((e) => e.isDirectory && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      const jsonFiles = entries
        .filter((e) => e.isFile && e.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name));
      setBrowserEntries([...dirs, ...jsonFiles]);
      setBrowserPath(target);
    } catch (err) {
      setBrowserError(err instanceof Error ? err.message : 'Failed to list directory');
    } finally {
      setBrowserLoading(false);
    }
  }, [currentDirectory]);

  const handleOpenBrowser = React.useCallback(() => {
    setParseError(null);
    setStep('browse-files');
    void loadBrowserDir(null);
  }, [loadBrowserDir]);

  const handleBrowserEntry = React.useCallback(async (entry: FilesystemEntry) => {
    if (entry.isDirectory) {
      void loadBrowserDir(entry.path);
      return;
    }
    // It's a .json file — try to read and validate
    setBrowserLoading(true);
    setParseError(null);
    try {
      console.log('[AgentLoopLauncher] Reading file:', entry.path, '| browserPath:', browserPath, '| currentDirectory:', currentDirectory);
      const content = await opencodeClient.readLocalFile(entry.path);
      console.log('[AgentLoopLauncher] readLocalFile result:', content ? `${content.length} chars` : 'null');
      if (!content) {
        // HTTP file reading not available — fall back to system file picker
        setParseError(
          `Cannot read files directly in this environment. Use the system file picker below to select "${entry.name}".`
        );
        setBrowserLoading(false);
        return;
      }
      const parsed = JSON.parse(content) as unknown;
      if (!validateWorkpackageFile(parsed)) {
        setParseError('Invalid workpackage file. Expected JSON with "name" and "workpackages" array.');
        setBrowserLoading(false);
        return;
      }
      setWorkpackageFile({ ...parsed, filePath: entry.path });
      setStep('configure');
    } catch {
      setParseError(
        `Could not parse the selected file. Use the system file picker below to select "${entry.name}".`
      );
    } finally {
      setBrowserLoading(false);
    }
  }, [loadBrowserDir, browserPath, currentDirectory]);

  const handleBrowserNavigateUp = React.useCallback(() => {
    if (!browserPath) return;
    const parent = browserPath.includes('/')
      ? browserPath.replace(/\/[^/]+\/?$/, '') || '/'
      : null;
    void loadBrowserDir(parent);
  }, [browserPath, loadBrowserDir]);

  // System file picker fallback
  const handleFileUpload = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      setParseError('Please select a .json file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result;
        if (typeof content !== 'string') { setParseError('Failed to read file'); return; }
        const parsed = JSON.parse(content) as unknown;
        if (!validateWorkpackageFile(parsed)) {
          setParseError('Invalid workpackage file. Expected JSON with "name" and "workpackages" array.');
          return;
        }
        setParseError(null);
        setWorkpackageFile(parsed);
        setStep('configure');
      } catch {
        setParseError('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleGenerate = React.useCallback(async () => {
    if (!generatePrompt.trim()) {
      toast.error('Please describe what you want to accomplish');
      return;
    }
    if (!selectedProviderId || !selectedModelId) {
      toast.error('Please select a model first');
      return;
    }

    setIsSubmitting(true);
    try {
      const sessionId = await startPlanningSession({
        goal: generatePrompt.trim(),
        providerID: selectedProviderId,
        modelID: selectedModelId,
        agent: selectedAgent || undefined,
        directory: currentDirectory || undefined,
      });

      if (sessionId) {
        setCurrentSession(sessionId);
        toast.info('Generating workpackage plan — "View plan" and "Implement" buttons will appear when ready.');
        onCreated?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start planning session');
    } finally {
      setIsSubmitting(false);
    }
  }, [generatePrompt, selectedProviderId, selectedModelId, selectedAgent, startPlanningSession, setCurrentSession, onCreated]);

  const handleStartLoop = React.useCallback(async () => {
    if (!workpackageFile) return;
    if (!selectedProviderId || !selectedModelId) {
      toast.error('Please select a model');
      return;
    }

    const filePath = workpackageFile.filePath;
    if (!filePath) {
      toast.error('Workpackage file path is required');
      return;
    }

    setIsSubmitting(true);
    try {
      const loopId = await startLoop({
        filePath,
        providerID: selectedProviderId,
        modelID: selectedModelId,
        agent: selectedAgent || undefined,
        variant: selectedVariant || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        directory: currentDirectory || undefined,
      });

      if (loopId) {
        const loop = useAgentLoopStore.getState().loops.get(loopId);
        if (loop?.parentSessionId) setCurrentSession(loop.parentSessionId);
        toast.success(`Agent loop "${workpackageFile.name}" started`);
        onCreated?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent loop');
    } finally {
      setIsSubmitting(false);
    }
  }, [workpackageFile, selectedProviderId, selectedModelId, selectedVariant, selectedAgent, systemPrompt, startLoop, setCurrentSession, onCreated]);

  const handleModelChange = React.useCallback((providerId: string, modelId: string) => {
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);
    setSelectedVariant(undefined);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="typography-heading-lg text-foreground">Agent Loop</h2>
        <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close">
          <RiCloseLine className="h-5 w-5" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-lg space-y-6">

          {/* ── Step 1: Choose source ─────────────────────────────────────── */}
          {step === 'choose-source' && (
            <div className="space-y-4">
              <p className="typography-body text-foreground-muted">
                An agent loop processes a list of tasks sequentially, starting a new AI session for each one.
                Choose how to get started:
              </p>
              <div className="grid gap-3">
                <button
                  type="button"
                  onClick={handleOpenBrowser}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border border-border p-4',
                    'hover:bg-interactive-hover transition-colors text-left'
                  )}
                >
                  <RiFolderLine className="h-6 w-6 text-foreground-muted shrink-0" />
                  <div>
                    <div className="typography-label text-foreground">Select existing file</div>
                    <div className="typography-meta text-foreground-muted">
                      Browse your project for a .json workpackage file
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setStep('select-file')}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border border-border p-4',
                    'hover:bg-interactive-hover transition-colors text-left'
                  )}
                >
                  <RiFileTextLine className="h-6 w-6 text-foreground-muted shrink-0" />
                  <div>
                    <div className="typography-label text-foreground">Generate a plan</div>
                    <div className="typography-meta text-foreground-muted">
                      Describe what you want and an AI will create the workpackage file
                    </div>
                  </div>
                </button>
              </div>
              {parseError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 typography-meta text-destructive">
                  {parseError}
                </div>
              )}
            </div>
          )}

          {/* ── Step 2a: In-app file browser ─────────────────────────────── */}
          {step === 'browse-files' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep('choose-source')}>
                  ← Back
                </Button>
                <h3 className="typography-heading-sm text-foreground">Select workpackage file</h3>
              </div>

              {/* Path breadcrumb + up button */}
              <div className="flex items-center gap-1 typography-meta text-foreground-muted min-w-0">
                {browserPath && browserPath !== (currentDirectory ?? '/') && (
                  <button
                    type="button"
                    onClick={handleBrowserNavigateUp}
                    className="shrink-0 hover:text-foreground transition-colors"
                    aria-label="Go up one directory"
                  >
                    <RiArrowLeftSLine className="h-3.5 w-3.5" />
                  </button>
                )}
                <span className="truncate">{browserPath ?? currentDirectory ?? '/'}</span>
              </div>

              {/* File list */}
              <div className="rounded-lg border border-border overflow-hidden">
                {browserLoading ? (
                  <div className="flex items-center justify-center py-8 text-foreground-muted typography-meta">
                    Loading…
                  </div>
                ) : browserError ? (
                  <div className="px-3 py-4 typography-meta text-destructive">{browserError}</div>
                ) : browserEntries.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-foreground-muted typography-meta">
                    No directories or .json files here
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-border">
                    {browserEntries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => void handleBrowserEntry(entry)}
                        disabled={browserLoading}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-left',
                          'hover:bg-interactive-hover transition-colors',
                        )}
                      >
                        {entry.isDirectory
                          ? <RiFolderLine className="h-4 w-4 shrink-0 text-accent" />
                          : <RiFileTextLine className="h-4 w-4 shrink-0 text-foreground-muted" />
                        }
                        <span className="typography-label text-foreground truncate flex-1">
                          {entry.name}
                        </span>
                        {entry.isDirectory && (
                          <RiArrowRightSLine className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {parseError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 typography-meta text-destructive">
                  {parseError}
                </div>
              )}

              {/* System file picker fallback */}
              <div className="flex items-center gap-2 pt-1">
                <div className="flex-1 h-px bg-border" />
                <span className="typography-meta text-foreground-muted shrink-0">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 typography-meta text-foreground-muted hover:text-foreground transition-colors"
              >
                <RiUploadLine className="h-3.5 w-3.5 shrink-0" />
                Browse with system file picker…
              </button>
            </div>
          )}

          {/* ── Step 2b: Generate plan ────────────────────────────────────── */}
          {step === 'select-file' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep('choose-source')}>
                  ← Back
                </Button>
                <h3 className="typography-heading-sm text-foreground">Describe your plan</h3>
              </div>

              <div className="space-y-2">
                <label htmlFor="generate-prompt" className="typography-label text-foreground-muted">
                  What do you want to accomplish?
                </label>
                <Textarea
                  id="generate-prompt"
                  value={generatePrompt}
                  onChange={(e) => setGeneratePrompt(e.target.value)}
                  placeholder="Describe the overall task. The AI will break it down into sequential workpackages..."
                  rows={6}
                  className="resize-none"
                />
              </div>

              <div className="space-y-2">
                <label className="typography-label text-foreground-muted">Model</label>
                <ModelSelector
                  providerId={selectedProviderId}
                  modelId={selectedModelId}
                  onChange={handleModelChange}
                />
              </div>

              <div className="space-y-2">
                <label className="typography-label text-foreground-muted">Agent</label>
                <AgentSelector
                  value={selectedAgent}
                  onChange={setSelectedAgent}
                />
              </div>

              <Button
                onClick={handleGenerate}
                disabled={isSubmitting || !generatePrompt.trim() || !selectedModelId}
                className="w-full"
              >
                {isSubmitting ? 'Generating…' : 'Generate Workpackage Plan'}
              </Button>
            </div>
          )}

          {/* ── Step 3: Configure & start ─────────────────────────────────── */}
          {step === 'configure' && workpackageFile && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => {
                  setStep('choose-source');
                  setWorkpackageFile(null);
                }}>
                  ← Back
                </Button>
                <h3 className="typography-heading-sm text-foreground">
                  Configure &ldquo;{workpackageFile.name}&rdquo;
                </h3>
              </div>

              {/* Workpackage preview */}
              <div className="rounded-lg border border-border">
                <div className="border-b border-border px-3 py-2">
                  <span className="typography-label text-foreground">
                    {workpackageFile.workpackages.length} task{workpackageFile.workpackages.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-border">
                  {workpackageFile.workpackages.map((wp, idx) => (
                    <div key={wp.id} className="px-3 py-2">
                      <div className="typography-meta text-foreground">
                        <span className="text-foreground-muted mr-1.5">{idx + 1}.</span>
                        {wp.title}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="typography-label text-foreground-muted">Model</label>
                <ModelSelector
                  providerId={selectedProviderId}
                  modelId={selectedModelId}
                  onChange={handleModelChange}
                />
              </div>

              {availableVariants.length > 0 && (
                <div className="space-y-2">
                  <label className="typography-label text-foreground-muted">Thinking</label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={cn(
                        'rounded-md border px-3 py-1.5 typography-meta font-medium transition-colors',
                        !selectedVariant
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-border text-foreground-muted hover:border-foreground/30',
                      )}
                      onClick={() => setSelectedVariant(undefined)}
                    >
                      Default
                    </button>
                    {availableVariants.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={cn(
                          'rounded-md border px-3 py-1.5 typography-meta font-medium transition-colors',
                          selectedVariant === v
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-border text-foreground-muted hover:border-foreground/30',
                        )}
                        onClick={() => setSelectedVariant(v)}
                      >
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="typography-label text-foreground-muted">Agent</label>
                <AgentSelector
                  value={selectedAgent}
                  onChange={setSelectedAgent}
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="system-prompt" className="typography-label text-foreground-muted">
                  System prompt <span className="text-foreground-muted/60">(optional)</span>
                </label>
                <Textarea
                  id="system-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Optional instructions prepended to each task..."
                  rows={3}
                  className="resize-none"
                />
              </div>

              {loopError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 typography-meta text-destructive">
                  {loopError}
                </div>
              )}

              <Button
                onClick={handleStartLoop}
                disabled={isSubmitting || isCreating || !selectedModelId}
                className="w-full"
              >
                {isSubmitting || isCreating ? 'Starting…' : `Start Agent Loop (${workpackageFile.workpackages.length} tasks)`}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Hidden system file input (fallback) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileUpload}
      />
    </div>
  );
};
