import React from 'react';
import { RiCloseLine, RiUploadLine, RiFileTextLine } from '@remixicon/react';
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

type LauncherStep = 'choose-source' | 'select-file' | 'configure';

interface AgentLoopLauncherProps {
  onCreated?: () => void;
  onCancel?: () => void;
}

/**
 * Launcher form for starting a new Agent Loop.
 * Step 1: Choose whether to select an existing workpackage file or describe a new one.
 * Step 2: If selecting, pick/upload a JSON file. If generating, we create a session to make it.
 * Step 3: Configure model, agent, and prompt then start the loop.
 */
export const AgentLoopLauncher: React.FC<AgentLoopLauncherProps> = ({
  onCreated,
  onCancel,
}) => {
  const [step, setStep] = React.useState<LauncherStep>('choose-source');
  const [workpackageFile, setWorkpackageFile] = React.useState<WorkpackageFile | null>(null);
  const [systemPrompt, setSystemPrompt] = React.useState('');
  const [selectedProviderId, setSelectedProviderId] = React.useState('');
  const [selectedModelId, setSelectedModelId] = React.useState('');
  const [selectedAgent, setSelectedAgent] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [generatePrompt, setGeneratePrompt] = React.useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const currentProviderId = useConfigStore((s) => s.currentProviderId);
  const currentModelId = useConfigStore((s) => s.currentModelId);
  const { startLoop, isCreating, error: loopError } = useAgentLoopStore();
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);

  // Default to current model
  React.useEffect(() => {
    if (!selectedProviderId && currentProviderId) setSelectedProviderId(currentProviderId);
    if (!selectedModelId && currentModelId) setSelectedModelId(currentModelId);
  }, [currentProviderId, currentModelId, selectedProviderId, selectedModelId]);

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
        if (typeof content !== 'string') {
          setParseError('Failed to read file');
          return;
        }
        const parsed = JSON.parse(content) as unknown;
        if (!validateWorkpackageFile(parsed)) {
          setParseError(
            'Invalid workpackage file. Expected JSON with "name" (string) and "workpackages" (array of {id, title, description}).'
          );
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

    // Reset input so re-selecting the same file triggers onChange
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
      // Create a session to generate the workpackage file
      const { opencodeClient } = await import('@/lib/opencode/client');
      const session = await opencodeClient.createSession({
        title: '🔄 Generate Workpackage Plan',
      });

      const planPrompt = `You are a project planning assistant. The user wants to accomplish the following:

${generatePrompt.trim()}

Analyze the codebase and create a workpackage plan as a JSON file. The JSON must follow this exact schema:
{
  "name": "Short name for the plan",
  "workpackages": [
    {
      "id": "unique-id-1",
      "title": "Short task title",
      "description": "Detailed description of what needs to be done for this specific task. Include enough context so an AI agent can complete it independently.",
      "status": "pending"
    }
  ]
}

Rules:
- Break the work into small, focused tasks that can each be completed independently
- Each task should be self-contained with all necessary context
- Order tasks logically (dependencies first)
- Use descriptive IDs (e.g., "setup-database", "add-auth-middleware")
- Keep tasks focused on a single concern
- Output ONLY the JSON, no explanation

Output the JSON now:`;

      await opencodeClient.sendMessage({
        id: session.id,
        providerID: selectedProviderId,
        modelID: selectedModelId,
        text: planPrompt,
        agent: selectedAgent || undefined,
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              workpackages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['pending'] },
                  },
                  required: ['id', 'title', 'description', 'status'],
                },
              },
            },
            required: ['name', 'workpackages'],
          },
        },
      });

      // Switch to the generation session so the user can see the output
      setCurrentSession(session.id);
      toast.info('Generating workpackage plan... Watch the chat for the output, then copy the JSON into a file and use "Select existing file".');
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate workpackage plan');
    } finally {
      setIsSubmitting(false);
    }
  }, [generatePrompt, selectedProviderId, selectedModelId, selectedAgent, setCurrentSession, onCreated]);

  const handleStartLoop = React.useCallback(async () => {
    if (!workpackageFile) return;
    if (!selectedProviderId || !selectedModelId) {
      toast.error('Please select a model');
      return;
    }

    setIsSubmitting(true);
    try {
      const loopId = await startLoop({
        workpackageFile,
        providerID: selectedProviderId,
        modelID: selectedModelId,
        agent: selectedAgent || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
      });

      if (loopId) {
        const loop = useAgentLoopStore.getState().loops.get(loopId);
        if (loop?.parentSessionId) {
          setCurrentSession(loop.parentSessionId);
        }
        toast.success(`Agent loop "${workpackageFile.name}" started`);
        onCreated?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent loop');
    } finally {
      setIsSubmitting(false);
    }
  }, [workpackageFile, selectedProviderId, selectedModelId, selectedAgent, systemPrompt, startLoop, setCurrentSession, onCreated]);

  const handleModelChange = React.useCallback((providerId: string, modelId: string) => {
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);
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
          {step === 'choose-source' && (
            <div className="space-y-4">
              <p className="typography-body text-foreground-muted">
                An agent loop processes a list of tasks sequentially, starting a new AI session for each one.
                Choose how to get started:
              </p>
              <div className="grid gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border border-border p-4',
                    'hover:bg-interactive-hover transition-colors text-left'
                  )}
                >
                  <RiUploadLine className="h-6 w-6 text-foreground-muted shrink-0" />
                  <div>
                    <div className="typography-label text-foreground">Select existing file</div>
                    <div className="typography-meta text-foreground-muted">
                      Upload a .json workpackage file from your repo
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
                {isSubmitting ? 'Generating...' : 'Generate Workpackage Plan'}
              </Button>
            </div>
          )}

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

              {(loopError) && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 typography-meta text-destructive">
                  {loopError}
                </div>
              )}

              <Button
                onClick={handleStartLoop}
                disabled={isSubmitting || isCreating || !selectedModelId}
                className="w-full"
              >
                {isSubmitting || isCreating ? 'Starting...' : `Start Agent Loop (${workpackageFile.workpackages.length} tasks)`}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input */}
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
