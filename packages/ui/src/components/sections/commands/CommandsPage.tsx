import React from 'react';
import { ButtonSmall } from '@/components/ui/button-small';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useCommandsStore, type CommandConfig, type CommandScope } from '@/stores/useCommandsStore';
import { RiTerminalBoxLine, RiUser3Line, RiFolderLine } from '@remixicon/react';
import { ModelSelector } from '../agents/ModelSelector';
import { AgentSelector } from './AgentSelector';
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
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{
    draftName: string;
    draftScope: CommandScope;
    description: string;
    agent: string;
    model: string;
    template: string;
  } | null>(null);

  React.useEffect(() => {
    if (isNewCommand && commandDraft) {
      const draftNameValue = commandDraft.name || '';
      const draftScopeValue = commandDraft.scope || 'user';
      const descriptionValue = commandDraft.description || '';
      const agentValue = commandDraft.agent || '';
      const modelValue = commandDraft.model || '';
      const templateValue = commandDraft.template || '';
      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);

      initialStateRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
      };
    } else if (selectedCommand) {
      const descriptionValue = selectedCommand.description || '';
      const agentValue = selectedCommand.agent || '';
      const modelValue = selectedCommand.model || '';
      const templateValue = selectedCommand.template || '';
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);

      initialStateRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
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
    return false;
  }, [agent, description, draftName, draftScope, isNewCommand, model, template]);

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
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {isNewCommand ? 'New Command' : `/${selectedCommandName}`}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isNewCommand ? 'Configure a new slash command' : 'Edit command settings'}
            </p>
          </div>
        </div>

        {/* Identity */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              Identity
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewCommand && (
              <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground">Command Name</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                  <div className="flex items-center">
                    <span className="typography-ui-label text-muted-foreground mr-1">/</span>
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="command-name"
                      className="h-7 w-40 px-2"
                    />
                  </div>
                  <Select value={draftScope} onValueChange={(v) => setDraftScope(v as CommandScope)}>
                    <SelectTrigger className="w-fit min-w-[100px]">
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

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">Description</span>
              <div className="mt-1.5">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this command do?"
                  rows={2}
                  className="w-full resize-none min-h-[60px] bg-transparent"
                />
              </div>
            </div>

          </section>
        </div>

        {/* Execution Context */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              Execution Context
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">Override Agent</span>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                <AgentSelector
                  agentName={agent}
                  onChange={(agentName: string) => setAgent(agentName)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">Override Model</span>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
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

          </section>
        </div>

        {/* Command Template */}
        <div className="mb-2">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              Command Template
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={`Your command template here...\n\nUse $ARGUMENTS to reference user input.\nUse !\`shell command\` to inject shell output.\nUse @filename to include file contents.`}
              rows={12}
              className="w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent resize-y"
            />
          </section>

          <div className="mt-2 px-2">
            <p className="typography-meta text-muted-foreground">
              <code className="text-foreground">$ARGUMENTS</code> user input &middot;{' '}
              <code className="text-foreground">!`cmd`</code> shell output &middot;{' '}
              <code className="text-foreground">@file</code> file contents
            </p>
          </div>
        </div>

        {/* Save action */}
        <div className="px-2 py-1">
          <ButtonSmall
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </ButtonSmall>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
