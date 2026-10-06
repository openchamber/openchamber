import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import { EnvironmentVariablesEditor } from '@/components/sections/shared/EnvironmentVariablesEditor';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  fetchProjectEnvironment,
  reloadProjectEnvironment,
  updateProjectEnvironment,
  type EnvironmentCommandStatus,
  type EnvironmentVariablesPatch,
  type ProjectEnvironment,
} from '@/lib/environmentApi';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n, type I18nKey } from '@/lib/i18n';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; environment: ProjectEnvironment }
  | { state: 'failed' };

// Reasons the server reports for a failed run; one it adds later reads as a
// plain failure.
const failureKey = (reason: string): I18nKey => {
  switch (reason) {
    case 'timeout': return 'settings.projects.environment.status.timeout';
    case 'unrecognized-output': return 'settings.projects.environment.status.unrecognizedOutput';
    case 'spawn': return 'settings.projects.environment.status.spawn';
    case 'output-too-large': return 'settings.projects.environment.status.outputTooLarge';
    default: return 'settings.projects.environment.status.failed';
  }
};

const useStatusText = (status: EnvironmentCommandStatus | null): string | null => {
  const { t } = useI18n();
  if (!status) return null;
  if (status.state === 'applied') {
    return status.count === 1
      ? t('settings.projects.environment.status.appliedSingle')
      : t('settings.projects.environment.status.appliedPlural', { count: status.count });
  }
  if (status.reason === 'exit') {
    // No exit code means a signal ended the command.
    return status.exitCode === null || status.exitCode === undefined
      ? t('settings.projects.environment.status.stopped')
      : t('settings.projects.environment.status.exitCode', { code: status.exitCode });
  }
  return t(failureKey(status.reason));
};

/**
 * A project's variables and its environment command (direnv, devenv), for
 * Git, the terminal and project actions in the project and its worktrees.
 * The managed OpenCode serves every project at once, so it never gets these.
 */
export const ProjectEnvironmentSection: React.FC<{ projectRef: ProjectRef }> = ({ projectRef }) => {
  const { t } = useI18n();
  const [load, setLoad] = React.useState<LoadState>({ state: 'loading' });
  const [commandDraft, setCommandDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const applyEnvironment = React.useCallback((environment: ProjectEnvironment) => {
    setLoad({ state: 'ready', environment });
    setCommandDraft(environment.command ?? '');
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    fetchProjectEnvironment(projectRef.id)
      .then((environment) => {
        if (!cancelled) applyEnvironment(environment);
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [applyEnvironment, projectRef.id]);

  const save = React.useCallback(async (patch: { variables?: EnvironmentVariablesPatch; command?: string | null }): Promise<boolean> => {
    reportSettingsSaveState('saving');
    try {
      applyEnvironment(await updateProjectEnvironment(projectRef.id, patch));
      reportSettingsSaveState('saved');
      return true;
    } catch {
      reportSettingsSaveState('error');
      toast.error(t('settings.environment.editor.saveFailed'));
      return false;
    }
  }, [applyEnvironment, projectRef.id, t]);

  const storedCommand = load.state === 'ready' ? load.environment.command ?? '' : '';
  const commandChanged = commandDraft.trim() !== storedCommand;

  const handleSaveCommand = async () => {
    setBusy(true);
    try {
      const saved = await save({ command: commandDraft.trim() || null });
      // A new command runs right away, so its outcome shows without waiting
      // for the next Git or terminal start.
      if (saved && commandDraft.trim()) {
        applyEnvironment(await reloadProjectEnvironment(projectRef.id));
      }
    } catch {
      toast.error(t('settings.projects.environment.runFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleRunAgain = async () => {
    setBusy(true);
    try {
      applyEnvironment(await reloadProjectEnvironment(projectRef.id));
    } catch {
      toast.error(t('settings.projects.environment.runFailed'));
    } finally {
      setBusy(false);
    }
  };

  const status = load.state === 'ready' ? load.environment.status : null;
  const statusText = useStatusText(status);
  const disabled = load.state !== 'ready' || busy;

  return (
    <ProjectSettingsSubsection
      title={t('settings.projects.environment.title')}
      info={t('settings.projects.environment.info')}
      settingsItem="projects.environment"
    >
      {load.state === 'failed' ? (
        <p className="typography-meta text-[var(--status-error)]">{t('settings.environment.editor.loadFailed')}</p>
      ) : (
        <div className="space-y-6">
          <EnvironmentVariablesEditor
            names={load.state === 'ready' ? load.environment.names : []}
            disabled={load.state !== 'ready'}
            onSet={(name, value) => save({ variables: { [name]: value } })}
            onRemove={(name) => save({ variables: { [name]: null } })}
          />

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.projects.environment.command.label')}</span>
              <SettingsInfoHint>{t('settings.projects.environment.command.info')}</SettingsInfoHint>
            </div>
            <form
              className="flex w-full max-w-[32rem] flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveCommand();
              }}
            >
              <Input
                value={commandDraft}
                onChange={(event) => setCommandDraft(event.target.value)}
                // A command, not prose: the same in every language.
                placeholder="direnv export json"
                aria-label={t('settings.projects.environment.command.label')}
                disabled={disabled}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
              {commandChanged ? (
                <Button type="submit" size="xs" disabled={disabled} className="shrink-0 !font-normal">
                  {t('settings.environment.editor.save')}
                </Button>
              ) : storedCommand ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void handleRunAgain()}
                  disabled={disabled}
                  className="shrink-0 !font-normal"
                >
                  {t('settings.projects.environment.command.runAgain')}
                </Button>
              ) : null}
            </form>
            {storedCommand && statusText ? (
              <p
                className={status?.state === 'failed'
                  ? 'typography-meta text-[var(--status-error)]'
                  : SETTINGS_HELPER_CLASS}
              >
                {statusText}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </ProjectSettingsSubsection>
  );
};
