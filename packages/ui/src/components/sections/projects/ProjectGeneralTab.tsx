import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { modelVariantNames } from '@/lib/modelVariants';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { updateSharedProjectSetup, type ProjectRef } from '@/lib/openchamberConfig';
import { ensureSharedSetupTrusted, resetSharedSetupTrust } from '@/lib/sharedTrustConfirmation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { useProjectIdentityForm } from './useProjectIdentityForm';
import type { ProjectSetupState } from './useProjectSetup';
import { ProjectSetupUnavailable } from './ProjectSettingsBits';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

const NO_VARIANT_VALUE = '__default__';

const formatVariantLabel = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

const ChatDefaultsSection: React.FC<{ form: ProjectIdentityFormState }> = ({ form }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, form.project?.path));
  const { parsedDefaultModel, defaultVariant } = form;

  const availableVariants = React.useMemo(() => {
    const { providerId, modelId } = parsedDefaultModel;
    if (!providerId || !modelId) return [];
    const model = providers
      .find((provider) => provider.id === providerId)
      ?.models.find((entry) => entry.id === modelId);
    return modelVariantNames(model);
  }, [parsedDefaultModel, providers]);

  if (!form.project) return null;

  return (
    <SettingsSection
      title={t('settings.projects.page.section.chatDefaults')}
      info={t('settings.projects.page.section.chatDefaultsDescription')}
      divider={false}
      contentClassName="space-y-0"
    >
      <SettingsFieldRow settingsItem="projects.default-agent" label={t('settings.projects.page.field.projectAgent')}>
        <AgentSelector
          directory={form.project.path}
          agentName={form.defaultAgent || ''}
          onChange={(agentName) => form.setDefaultAgent(agentName || undefined)}
          filter={(agent) => isPrimaryMode(agent.mode)}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </SettingsFieldRow>

      <SettingsFieldRow settingsItem="projects.default-model" label={t('settings.projects.page.field.projectModel')}>
        <ModelSelector
          directory={form.project.path}
          providerId={parsedDefaultModel.providerId}
          modelId={parsedDefaultModel.modelId}
          onChange={form.handleDefaultModelChange}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </SettingsFieldRow>

      {availableVariants.length > 0 ? (
        <SettingsFieldRow settingsItem="projects.default-thinking" label={t('settings.projects.page.field.projectThinking')}>
          <Select
            value={defaultVariant ?? NO_VARIANT_VALUE}
            onValueChange={(value) => form.handleDefaultVariantChange(value === NO_VARIANT_VALUE ? undefined : value)}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.projects.page.field.projectThinking')}>
              <SelectValue>
                {defaultVariant ? formatVariantLabel(defaultVariant) : t('settings.projects.page.option.thinkingDefault')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_VARIANT_VALUE}>{t('settings.projects.page.option.thinkingDefault')}</SelectItem>
              {availableVariants.map((variant) => (
                <SelectItem key={variant} value={variant}>{formatVariantLabel(variant)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      ) : null}
    </SettingsSection>
  );
};

/**
 * The team's file in the repo: whether it is there and readable, whether
 * its commands may run on this machine, and the plans folder it names.
 * Actions and setup commands are shared from their own tabs.
 */
const TeamFileSection: React.FC<{ projectRef: ProjectRef; setupState: ProjectSetupState }> = ({ projectRef, setupState }) => {
  const { t } = useI18n();
  const { load, reload } = setupState;
  const setup = load.state === 'ready' ? load.setup : null;
  const [plansDirDraft, setPlansDirDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const storedPlansDir = setup?.shared.plansDir ?? '';

  React.useEffect(() => setPlansDirDraft(storedPlansDir), [storedPlansDir]);

  const savePlansDir = async () => {
    const next = plansDirDraft.trim();
    if (next === storedPlansDir) return;
    setBusy(true);
    try {
      if (!(await updateSharedProjectSetup(projectRef, { plansDir: next || null }))) {
        toast.error(t('settings.projects.shared.toast.shareFailed'));
        setPlansDirDraft(storedPlansDir);
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const reviewTrust = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      await ensureSharedSetupTrusted(projectRef, setup);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const forgetTrust = async () => {
    setBusy(true);
    try {
      if (!(await resetSharedSetupTrust(projectRef))) {
        toast.error(t('settings.projects.shared.toast.shareFailed'));
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.projects.team.title')}
      settingsItem="projects.shared"
      contentClassName="space-y-5"
    >
      {!setup ? (
        <ProjectSetupUnavailable setupState={setupState} />
      ) : (
        <>
          {/* What the file is and what it holds, said once in a sentence. */}
          <p className={cn('max-w-[40rem]', setup.shared.status === 'invalid' ? 'typography-meta text-[var(--status-warning)]' : SETTINGS_HELPER_CLASS)}>
            {setup.shared.status === 'invalid'
              ? t('settings.projects.shared.invalid', { path: setup.shared.path, reason: setup.shared.reason ?? '' })
              : setup.shared.status === 'ok'
                ? t('settings.projects.team.description.ok', { path: setup.shared.path })
                : t('settings.projects.team.description.missing', { path: setup.shared.path })}
          </p>

          {setup.trust.hash !== null ? (
            <div
              className={cn(
                'flex max-w-[40rem] items-center gap-3 rounded-lg p-3',
                setup.trust.trusted
                  ? 'oc-tile'
                  : 'bg-[var(--status-warning)]/10',
              )}
            >
              <Icon
                name={setup.trust.trusted ? 'shield-check' : 'error-warning'}
                className={cn('size-4 shrink-0', setup.trust.trusted ? 'text-[var(--status-success)]' : 'text-[var(--status-warning)]')}
              />
              <p className="min-w-0 flex-1 typography-meta text-foreground">
                {setup.trust.trusted ? t('settings.projects.team.trust.allowed') : t('settings.projects.team.trust.waiting')}
              </p>
              {setup.trust.trusted ? (
                <Button type="button" size="xs" variant="ghost" className="shrink-0 !font-normal" disabled={busy} onClick={() => void forgetTrust()}>
                  {t('settings.projects.team.trust.revoke')}
                </Button>
              ) : (
                <Button type="button" size="xs" variant="outline" className="shrink-0" disabled={busy} onClick={() => void reviewTrust()}>
                  {t('settings.projects.team.trust.review')}
                </Button>
              )}
            </div>
          ) : null}

          <SettingsFieldRow
            label={t('settings.projects.shared.plansDir')}
            info={t('settings.projects.shared.plansDirInfo')}
            settingsItem="projects.shared.plansDir"
          >
            <Input
              value={plansDirDraft}
              onChange={(event) => setPlansDirDraft(event.target.value)}
              onBlur={() => void savePlansDir()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder={t('settings.projects.shared.plansDirPlaceholder')}
              aria-label={t('settings.projects.shared.plansDirAria')}
              disabled={busy || setup.shared.status === 'invalid'}
              className="h-8 rounded-md px-3 font-mono text-xs"
            />
          </SettingsFieldRow>
        </>
      )}
    </SettingsSection>
  );
};

export const ProjectGeneralTab: React.FC<{
  form: ProjectIdentityFormState;
  projectRef: ProjectRef;
  setupState: ProjectSetupState;
}> = ({ form, projectRef, setupState }) => (
  <>
    <ChatDefaultsSection form={form} />
    <TeamFileSection projectRef={projectRef} setupState={setupState} />
  </>
);
