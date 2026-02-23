import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { useCommandsStore, type CommandConfig, type CommandScope } from '@/stores/useCommandsStore';
import { RiInformationLine, RiTerminalBoxLine, RiUser3Line, RiFolderLine } from '@remixicon/react';
import { ModelSelector } from '../agents/ModelSelector';
import { AgentSelector } from './AgentSelector';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const CommandsPage: React.FC = () => {
  const { selectedCommandName, getCommandByName, createCommand, updateCommand, commands, commandDraft, setCommandDraft } = useCommandsStore();

  const selectedCommand = selectedCommandName ? getCommandByName(selectedCommandName) : null;
  const isNewCommand = Boolean(commandDraft && commandDraft.name === selectedCommandName && !selectedCommand);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<CommandScope>('user');
  const [description, setDescription] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [model, setModel] = React.useState('');
  const [template, setTemplate] = React.useState('');
  const [subtask, setSubtask] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{
    draftName: string;
    draftScope: CommandScope;
    description: string;
    agent: string;
    model: string;
    template: string;
    subtask: boolean;
  } | null>(null);

  React.useEffect(() => {
    if (isNewCommand && commandDraft) {
      const draftNameValue = commandDraft.name || '';
      const draftScopeValue = commandDraft.scope || 'user';
      const descriptionValue = commandDraft.description || '';
      const agentValue = commandDraft.agent || '';
      const modelValue = commandDraft.model || '';
      const templateValue = commandDraft.template || '';
      const subtaskValue = commandDraft.subtask || false;

      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);
      setSubtask(subtaskValue);

      initialStateRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
        subtask: subtaskValue,
      };
    } else if (selectedCommand) {
      const descriptionValue = selectedCommand.description || '';
      const agentValue = selectedCommand.agent || '';
      const modelValue = selectedCommand.model || '';
      const templateValue = selectedCommand.template || '';
      const subtaskValue = selectedCommand.subtask || false;

      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);
      setSubtask(subtaskValue);

      initialStateRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
        subtask: subtaskValue,
      };
    }
  }, [selectedCommand, isNewCommand, selectedCommandName, commands, commandDraft]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) {
      return false;
    }

    if (isNewCommand) {
      if (draftName !== initial.draftName) return true;
      if (draftScope !== initial.draftScope) return true;
    }

    if (description !== initial.description) return true;
    if (agent !== initial.agent) return true;
    if (model !== initial.model) return true;
    if (template !== initial.template) return true;
    if (subtask !== initial.subtask) return true;

    return false;
  }, [agent, description, draftName, draftScope, isNewCommand, model, subtask, template]);

  const handleSave = async () => {
    const commandName = isNewCommand ? draftName.trim().replace(/\s+/g, '-') : selectedCommandName?.trim();
    
    if (!commandName) {
      toast.error('Command name is required');
      return;
    }

    if (!template.trim()) {
      toast.error('Command template is required');
      return;
    }

    if (isNewCommand && commands.some((cmd) => cmd.name === commandName)) {
      toast.error('A command with this name already exists');
      return;
    }

    setIsSaving(true);

    try {
      const trimmedAgent = agent.trim();
      const trimmedModel = model.trim();
      const trimmedTemplate = template.trim();
      const config: CommandConfig = {
        name: commandName,
        description: description.trim() || undefined,
        agent: trimmedAgent === '' ? null : trimmedAgent,
        model: trimmedModel === '' ? null : trimmedModel,
        template: trimmedTemplate,
        subtask,
        scope: isNewCommand ? draftScope : undefined,
      };

      let success: boolean;
      if (isNewCommand) {
        success = await createCommand(config);
        if (success) {
          setCommandDraft(null); 
        }
      } else {
        success = await updateCommand(commandName, config);
      }

      if (success) {
        toast.success(isNewCommand ? 'Command created successfully' : 'Command updated successfully');
      } else {
        toast.error(isNewCommand ? 'Failed to create command' : 'Failed to update command');
      }
    } catch (error) {
      console.error('Error saving command:', error);
      toast.error('An error occurred while saving');
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedCommandName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiTerminalBoxLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">Select a command from the sidebar</p>
          <p className="typography-meta mt-1 opacity-75">or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        
        {/* Header & Actions */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {isNewCommand ? 'New Command' : `/${selectedCommandName}`}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isNewCommand ? 'Configure a new slash command' : 'Edit command settings'}
            </p>
          </div>
          <Button onClick={handleSave} disabled={isSaving || !isDirty} size="sm">
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>

        {/* Basic Information */}
        <div className="mb-8">
          <div className="mb-3 px-1">
            <h3 className="typography-ui-header font-semibold text-foreground">
              Identity
            </h3>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Configure command name and description.
            </p>
          </div>

          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            
            {isNewCommand && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
                <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                  <span className="typography-ui-label text-foreground">Command Name</span>
                </div>
                <div className="flex items-center gap-2 flex-1 justify-end">
                  <div className="flex items-center flex-1 max-w-[200px]">
                    <span className="typography-ui-label text-muted-foreground mr-1">/</span>
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="command-name"
                      className="flex-1 h-8 px-2 focus-visible:ring-[var(--primary-base)]"
                    />
                  </div>
                  <Select value={draftScope} onValueChange={(v) => setDraftScope(v as CommandScope)}>
                    <SelectTrigger className="h-8 w-fit min-w-[100px]">
                      <SelectValue placeholder="Scope" />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="user">
                        <div className="flex items-center gap-2">
                          <RiUser3Line className="h-3.5 w-3.5" />
                          <span>Global</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <RiFolderLine className="h-3.5 w-3.5" />
                          <span>Project</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0 pt-1">
                <span className="typography-ui-label text-foreground">Description</span>
              </div>
              <div className="flex-1">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this command do?"
                  rows={2}
                  className="w-full resize-none min-h-[60px] bg-transparent focus-visible:ring-[var(--primary-base)]"
                />
              </div>
            </div>

          </div>
        </div>

        {/* Model & Agent Configuration */}
        <div className="mb-8">
          <div className="mb-3 px-1">
            <h3 className="typography-ui-header font-semibold text-foreground">
              Execution Context
            </h3>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Configure which model and agent handles this command.
            </p>
          </div>

          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                <span className="typography-ui-label text-foreground">Override Agent</span>
              </div>
              <div className="flex-1 max-w-sm flex justify-end">
                <AgentSelector
                  agentName={agent}
                  onChange={(agentName: string) => setAgent(agentName)}
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                <span className="typography-ui-label text-foreground">Override Model</span>
              </div>
              <div className="flex-1 max-w-sm flex justify-end">
                <ModelSelector
                  providerId={model ? model.split('/')[0] : ''}
                  modelId={model ? model.split('/')[1] : ''}
                  onChange={(providerId: string, modelId: string) => {
                    if (providerId && modelId) {
                      setModel(`${providerId}/${modelId}`);
                    } else {
                      setModel('');
                    }
                  }}
                />
              </div>
            </div>

            <label className="group flex cursor-pointer items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30">
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="typography-ui-label text-foreground">Force Subagent Context</span>
                  <Tooltip delayDuration={1000}>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      When enabled, this command will always execute in an isolated subagent context,<br/>
                      even if triggered from the main agent.<br/>
                      Useful for isolating command logic.
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <Switch
                checked={subtask}
                onCheckedChange={setSubtask}
                className="data-[state=checked]:bg-[var(--primary-base)]"
              />
            </label>

          </div>
        </div>

        {/* Command Template */}
        <div className="mb-8">
          <div className="mb-3 px-1">
            <h3 className="typography-ui-header font-semibold text-foreground">
              Command Template
            </h3>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Define the prompt template for this command. Use variables for user input.
            </p>
          </div>
          
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={`Your command template here...\n\nUse $ARGUMENTS to reference user input.\nUse !\`shell command\` to inject shell output.\nUse @filename to include file contents.`}
              rows={12}
              className="w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent focus-visible:ring-[var(--primary-base)] border-none shadow-none focus-visible:outline-none resize-y"
            />
          </div>

          <div className="mt-4 rounded-lg bg-muted/30 p-3">
            <p className="typography-meta text-foreground font-medium mb-2">Template Features</p>
            <ul className="list-disc list-inside space-y-1.5 ml-1 typography-meta text-muted-foreground">
              <li className="flex items-center gap-2">
                <code className="bg-background border border-[var(--interactive-border)] px-1 rounded text-foreground">$ARGUMENTS</code>
                <span>- User input after command</span>
              </li>
              <li className="flex items-center gap-2">
                <code className="bg-background border border-[var(--interactive-border)] px-1 rounded text-foreground">!`command`</code>
                <span>- Inject shell command output</span>
              </li>
              <li className="flex items-center gap-2">
                <code className="bg-background border border-[var(--interactive-border)] px-1 rounded text-foreground">@filename</code>
                <span>- Include file contents</span>
              </li>
            </ul>
          </div>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
