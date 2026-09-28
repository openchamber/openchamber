import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { selectCommandsForDirectory, useCommandsStore, type CommandConfig, type CommandScope } from '@/stores/useCommandsStore';
import { useShallow } from 'zustand/react/shallow';
import { ModelSelector } from '../agents/ModelSelector';
import { AgentSelector } from './AgentSelector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { formatModelSelection, parseModelIdentifier, parseModelSelection } from '@/lib/modelIdentifier';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsLegacyFormatNote } from '@/components/sections/shared/SettingsLegacyFormatNote';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import {
  SettingsSection,
  SettingsFieldRow,
  SETTINGS_SELECT_SIZE,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';

/** Everything the page writes into the command's config file. */
interface CommandFormState {
  draftName: string;
  draftScope: CommandScope;
  description: string;
  agent: string;
  model: string;
  variant: string;
  subagent: boolean;
  template: string;
}

export const CommandsPage: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedCommandName,
    getCommandByName,
    createCommand,
    updateCommand,
    commandDraft,
    setCommandDraft,
    setSelectedCommand,
  } = useCommandsStore(useShallow((s) => ({
    selectedCommandName: s.selectedCommandName,
    getCommandByName: s.getCommandByName,
    createCommand: s.createCommand,
    updateCommand: s.updateCommand,
    commandDraft: s.commandDraft,
    setCommandDraft: s.setCommandDraft,
    setSelectedCommand: s.setSelectedCommand,
  })));

  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const commands = useCommandsStore((state) => selectCommandsForDirectory(state, settingsDirectory));
  const selectedCommand = selectedCommandName ? getCommandByName(selectedCommandName, settingsDirectory) : null;
  const isNewCommand = Boolean(commandDraft && commandDraft.name === selectedCommandName && !selectedCommand);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<CommandScope>('user');
  const [description, setDescription] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [model, setModel] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [subagent, setSubagent] = React.useState(false);
  const [template, setTemplate] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  // What the command file currently holds; a save writes only the difference.
  const savedRef = React.useRef<CommandFormState | null>(null);

  const formIdentity = JSON.stringify([settingsDirectory, selectedCommandName]);
  const formIdentityRef = React.useRef<string | null>(null);
  const writeEchoRef = React.useRef<{ identity: string; form: CommandFormState } | null>(null);

  React.useEffect(() => {
    const sameCommand = formIdentityRef.current === formIdentity;
    formIdentityRef.current = formIdentity;
    if (isNewCommand && commandDraft) {
      const draftNameValue = commandDraft.name || '';
      const draftScopeValue = commandDraft.scope || 'user';
      const descriptionValue = commandDraft.description || '';
      const agentValue = commandDraft.agent || '';
      const parsedModel = parseModelSelection(commandDraft.model);
      const modelValue = parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : '';
      const variantValue = parsedModel?.variant || '';
      const subagentValue = commandDraft.subagent === true;
      const templateValue = commandDraft.template || '';
      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setVariant(variantValue);
      setSubagent(subagentValue);
      setTemplate(templateValue);

      savedRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        variant: variantValue,
        subagent: subagentValue,
        template: templateValue,
      };
    } else if (selectedCommand) {
      const descriptionValue = selectedCommand.description || '';
      const agentValue = selectedCommand.agent || '';
      const parsedModel = parseModelSelection(selectedCommand.model);
      const modelValue = parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : '';
      const variantValue = parsedModel?.variant || '';
      const subagentValue = selectedCommand.subagent === true;
      const templateValue = selectedCommand.template || '';
      const pending = writeEchoRef.current;
      const echoes = [savedRef.current, pending?.identity === formIdentity ? pending.form : null];
      // OpenCode re-reads the file right after our own write, so the store
      // echoes back what we just saved. Only a genuinely different server
      // value is allowed to replace what the user has in the form.
      if (
        sameCommand && echoes.some((saved) => saved &&
          saved.description === descriptionValue &&
          saved.agent === agentValue &&
          saved.model === modelValue &&
          saved.variant === variantValue &&
          saved.subagent === subagentValue &&
          saved.template === templateValue)
      ) {
        return;
      }
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setVariant(variantValue);
      setSubagent(subagentValue);
      setTemplate(templateValue);

      savedRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        variant: variantValue,
        subagent: subagentValue,
        template: templateValue,
      };
    }
  }, [selectedCommand, isNewCommand, selectedCommandName, commands, commandDraft, formIdentity]);

  const buildConfig = React.useCallback((commandName: string): CommandConfig => {
    const trimmedAgent = agent.trim();
    const parsedModel = parseModelIdentifier(model.trim());
    const joinedModel = parsedModel
      ? formatModelSelection({
          providerID: parsedModel.providerId,
          modelID: parsedModel.modelId,
          variant: variant.trim() || undefined,
        })
      : null;
    return {
      name: commandName,
      description: description.trim() || undefined,
      agent: trimmedAgent === '' ? null : trimmedAgent,
      model: joinedModel,
      subagent,
      template: template.trim(),
      scope: isNewCommand ? draftScope : undefined,
    };
  }, [agent, description, draftScope, isNewCommand, model, subagent, template, variant]);

  // An existing command writes itself; a new one only exists once the user
  // confirms it, so an abandoned draft never reaches disk.
  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    const saved = savedRef.current;
    const commandName = selectedCommandName?.trim();
    if (isNewCommand || !saved || !commandName) return AUTOSAVE_UNCHANGED;

    const unchanged =
      description.trim() === saved.description.trim() &&
      agent.trim() === saved.agent.trim() &&
      model.trim() === saved.model.trim() &&
      variant.trim() === saved.variant.trim() &&
      subagent === saved.subagent &&
      template.trim() === saved.template.trim();
    if (unchanged) return AUTOSAVE_UNCHANGED;

    if (!template.trim()) {
      return autosaveFailed(t('settings.commands.page.toast.templateRequired'));
    }

    const config = buildConfig(commandName);
    const parsedModel = parseModelSelection(config.model);
    const pending = {
      identity: formIdentity,
      form: {
        ...saved,
        description: config.description || '',
        agent: config.agent || '',
        model: parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : '',
        variant: parsedModel?.variant || '',
        subagent: config.subagent === true,
        template: config.template || '',
      },
    };
    // The store publishes its reload before updateCommand resolves.
    writeEchoRef.current = pending;
    try {
      const success = await updateCommand(commandName, config, settingsDirectory);
      if (!success) {
        return autosaveFailed(t('settings.commands.page.toast.updateFailed'));
      }
      if (formIdentityRef.current === formIdentity) {
        savedRef.current = pending.form;
      }
      return AUTOSAVE_SAVED;
    } finally {
      if (writeEchoRef.current === pending) writeEchoRef.current = null;
    }
  }, [agent, buildConfig, description, formIdentity, isNewCommand, model, selectedCommandName, settingsDirectory, subagent, t, template, updateCommand, variant]);

  const autosave = useAutosave(save);
  const { requestSave } = autosave;

  const handleCreate = async () => {
    const commandName = draftName.trim().replace(/\s+/g, '-');
    if (!commandName) {
      toast.error(t('settings.commands.sidebar.toast.commandNameRequired'));
      return;
    }
    if (!template.trim()) {
      toast.error(t('settings.commands.page.toast.templateRequired'));
      return;
    }
    if (commands.some((cmd) => cmd.name === commandName)) {
      toast.error(t('settings.commands.sidebar.toast.commandExists'));
      return;
    }

    setIsCreating(true);
    try {
      const success = await createCommand(buildConfig(commandName), settingsDirectory);
      if (success) {
        setCommandDraft(null);
        toast.success(t('settings.commands.page.toast.created'));
      } else {
        toast.error(t('settings.commands.page.toast.createFailed'));
      }
    } catch (error) {
      console.error('Error creating command:', error);
      toast.error(t('settings.commands.page.toast.saveUnexpectedError'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleCancelCreate = () => {
    setCommandDraft(null);
    setSelectedCommand(null);
  };

  if (!selectedCommandName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="terminal-box" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.commands.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.commands.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <SettingsPageLayout
      title={isNewCommand ? t('settings.commands.page.title.new') : `/${selectedCommandName}`}
      description={isNewCommand ? t('settings.commands.page.subtitle.new') : t('settings.commands.page.subtitle.edit')}
      onBlurCapture={autosave.onBlurCapture}
    >
      {!isNewCommand && selectedCommand && (
        <SettingsLegacyFormatNote legacy={selectedCommand.legacy === true} path={selectedCommand.path} />
      )}
      <SettingsSection
        title={t('settings.commands.page.section.identity')}
        divider={false}
        contentClassName="space-y-0"
      >
        {isNewCommand && (
          <SettingsFieldRow
            settingsItem="commands.name"
            label={t('settings.commands.page.field.commandName')}
          >
            <div className="flex items-center">
              <span className="typography-ui-label text-muted-foreground mr-1">/</span>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t('settings.commands.page.field.commandNamePlaceholder')}
                className="h-7 w-40 px-2"
              />
            </div>
            <Select value={draftScope} onValueChange={(v) => setDraftScope(v as CommandScope)}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[100px]">
                <SelectValue placeholder={t('settings.agents.page.field.scopePlaceholder')} />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="user">
                  <div className="flex items-center gap-2">
                    <Icon name="user-3" className="h-3.5 w-3.5" />
                    <span>{t('settings.common.scope.global')}</span>
                  </div>
                </SelectItem>
                <SelectItem value="project">
                  <div className="flex items-center gap-2">
                    <Icon name="folder" className="h-3.5 w-3.5" />
                    <span>{t('settings.common.scope.project')}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        )}

        <div className="py-1.5">
          <span className="typography-ui-label text-foreground">{t('settings.common.field.description')}</span>
          <div className="mt-1.5">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.commands.page.field.descriptionPlaceholder')}
              rows={2}
              className="w-full resize-none min-h-[60px] bg-transparent"
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.commands.page.section.executionContext')}
        contentClassName="space-y-0"
      >
        <SettingsFieldRow
          settingsItem="commands.agent"
          label={t('settings.commands.page.field.overrideAgent')}
        >
          <AgentSelector
            agentName={agent}
            onChange={(agentName: string) => {
              setAgent(agentName);
              requestSave();
            }}
            className={SETTINGS_CUSTOM_TRIGGER_CLASS}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="commands.model"
          label={t('settings.agents.page.field.overrideModel')}
        >
          <ModelSelector
            providerId={parseModelIdentifier(model)?.providerId ?? ''}
            modelId={parseModelIdentifier(model)?.modelId ?? ''}
            onChange={(providerId: string, modelId: string) => {
              if (providerId && modelId) {
                setModel(`${providerId}/${modelId}`);
              } else {
                setModel('');
              }
              requestSave();
            }}
            className={SETTINGS_CUSTOM_TRIGGER_CLASS}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="commands.variant"
          label={t('settings.agents.page.field.variant')}
          info={t('settings.agents.page.field.variantTooltip')}
        >
          <Input
            value={variant}
            onChange={(event) => setVariant(event.target.value)}
            placeholder={t('settings.agents.page.field.variantPlaceholder')}
            disabled={!model && !variant}
            className="h-8 w-40 rounded-md px-3"
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="commands.subagent"
          label={t('settings.commands.page.field.subagent')}
          info={t('settings.commands.page.field.subagentTooltip')}
        >
          <Switch
            checked={subagent}
            onCheckedChange={(checked) => {
              setSubagent(checked);
              requestSave();
            }}
            aria-label={t('settings.commands.page.field.subagent')}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t('settings.commands.page.section.template')}
        settingsItem="commands.template"
      >
        <Textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder={t('settings.commands.page.field.templatePlaceholder')}
          rows={12}
          className="w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent"
        />
        <p className="mt-2 typography-meta text-muted-foreground">
          <code className="text-foreground">$ARGUMENTS</code> {t('settings.commands.page.templateHint.userInput')} &middot;{' '}
          <code className="text-foreground">!`cmd`</code> {t('settings.commands.page.templateHint.shellOutput')} &middot;{' '}
          <code className="text-foreground">@file</code> {t('settings.commands.page.templateHint.fileContents')}
        </p>
        {isNewCommand && (
          <div className="flex items-center gap-2 pt-3">
            <Button
              onClick={() => void handleCreate()}
              disabled={isCreating || !draftName.trim() || !template.trim()}
              size="xs"
              className="!font-normal"
            >
              {isCreating ? t('settings.common.actions.saving') : t('settings.common.actions.create')}
            </Button>
            <Button
              variant="ghost"
              onClick={handleCancelCreate}
              disabled={isCreating}
              size="xs"
              className="!font-normal"
            >
              {t('settings.common.actions.cancel')}
            </Button>
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
