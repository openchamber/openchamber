import React from 'react';

import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  parseProjectShellEnvVars,
  serializeProjectShellEnvVars,
} from '@/lib/projectShellEnv';
import {
  readProjectShellEnv,
  saveProjectShellEnv,
  type ProjectRef,
  type ProjectShellEnv,
  type ProjectShellEnvMode,
} from '@/lib/openchamberConfig';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import {
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsCheckboxRow,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const AUTO_SAVE_DELAY_MS = 450;
const SHELL_ENV_MODE_OVERLAY = 'overlay';
const SHELL_ENV_MODE_REPLACE = 'replace';

type DraftShellEnv = {
  enabled: boolean;
  command: string;
  mode: ProjectShellEnvMode;
  varsText: string;
};

const draftFromShellEnv = (shellEnv: ProjectShellEnv | null): DraftShellEnv => ({
  enabled: shellEnv?.enabled === true,
  command: shellEnv?.command ?? '',
  mode: shellEnv?.mode === 'replace' ? 'replace' : 'overlay',
  varsText: shellEnv ? serializeProjectShellEnvVars(shellEnv.vars) : '',
});

const snapshotOf = (draft: DraftShellEnv): string => JSON.stringify(draft);

interface ProjectShellEnvSectionProps {
  projectRef: ProjectRef;
}

/**
 * The project's opted-in dev environment. The command runs locally on every
 * Git, terminal, and fs-exec spawn for the project; it must be enabled here
 * explicitly and lives in the user's own project file, never the repository.
 * See `lib/projects/shell-env.js` on the server for the resolution rules.
 */
export const ProjectShellEnvSection: React.FC<ProjectShellEnvSectionProps> = ({ projectRef }) => {
  const { t } = useI18n();

  const [draft, setDraft] = React.useState<DraftShellEnv>(() => draftFromShellEnv(null));
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [initialSnapshot, setInitialSnapshot] = React.useState<string | null>(null);
  const isSavingRef = React.useRef(false);
  const validationToastRef = React.useRef<string | null>(null);
  // The project whose config the current draft was loaded from. Blocks a save
  // from landing on a different project if the user switches while the read is
  // in flight (the draft would otherwise belong to the previous project).
  const loadedProjectIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    loadedProjectIdRef.current = null;
    setIsLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const shellEnv = await readProjectShellEnv(projectRef);
        if (cancelled) return;
        loadedProjectIdRef.current = projectRef.id;
        const nextDraft = draftFromShellEnv(shellEnv);
        setDraft(nextDraft);
        setInitialSnapshot(snapshotOf(nextDraft));
      } catch {
        // A failed read must not read as "no configuration": show the failure
        // and leave the stored value alone instead of saving an empty draft.
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRef]);

  const { vars, invalid } = React.useMemo(
    () => parseProjectShellEnvVars(draft.varsText),
    [draft.varsText],
  );

  const validationError = invalid.length > 0
    ? t('settings.projects.shellEnv.vars.invalid', { names: invalid.join(', ') })
    : null;

  const hasChanges = initialSnapshot !== null && initialSnapshot !== snapshotOf(draft);

  const updateDraft = React.useCallback((patch: Partial<DraftShellEnv>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  React.useEffect(() => {
    if (!hasChanges || isLoading || loadFailed || validationError || isSavingRef.current || loadedProjectIdRef.current !== projectRef.id) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingRef.current) return;
      isSavingRef.current = true;
      void (async () => {
        try {
          const hasContent = draft.enabled || draft.command.trim().length > 0 || Object.keys(vars).length > 0;
          const next: ProjectShellEnv | null = hasContent
            ? { enabled: draft.enabled, command: draft.command.trim(), vars, mode: draft.mode }
            : null;
          const saved = await saveProjectShellEnv(projectRef, next);
          if (!saved) {
            toast.error(t('settings.projects.shellEnv.toast.saveFailed'));
            return;
          }
          setInitialSnapshot(snapshotOf(draft));
        } finally {
          isSavingRef.current = false;
        }
      })();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, hasChanges, isLoading, loadFailed, projectRef, t, validationError, vars]);

  React.useEffect(() => {
    if (!hasChanges || !validationError || isLoading) {
      if (!validationError) validationToastRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => {
      if (validationToastRef.current === validationError) return;
      validationToastRef.current = validationError;
      toast.error(validationError);
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [hasChanges, isLoading, validationError]);

  return (
    <ProjectSettingsSubsection
      title={t('settings.projects.shellEnv.title')}
      info={t('settings.projects.shellEnv.description')}
      settingsItem="projects.shellEnv"
      contentClassName="space-y-2"
    >
      {isLoading ? (
        <p className="typography-meta text-muted-foreground">{t('settings.projects.shellEnv.state.loading')}</p>
      ) : loadFailed ? (
        <p className="typography-meta text-[var(--status-warning)]">{t('settings.projects.shellEnv.state.loadFailed')}</p>
      ) : (
        <>
          <SettingsCheckboxRow
            checked={draft.enabled}
            onChange={(checked) => updateDraft({ enabled: checked })}
            label={t('settings.projects.shellEnv.enabled')}
            settingsItem="projects.shellEnv.enabled"
          />

          {draft.command.trim().length > 0 && !draft.enabled ? (
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.projects.shellEnv.disabledWarning')}
            </p>
          ) : null}

          <div className={cn('space-y-2', PROJECT_SETTINGS_CONTROL_WIDTH)}>
            <div>
              <div className="mb-0.5 flex items-center gap-2">
                <p className="typography-meta text-muted-foreground">{t('settings.projects.shellEnv.command.label')}</p>
                <SettingsInfoHint contentClassName="max-w-xs">
                  {t('settings.projects.shellEnv.command.info')}
                </SettingsInfoHint>
              </div>
              <Textarea
                value={draft.command}
                onChange={(event) => updateDraft({ command: event.target.value })}
                placeholder={t('settings.projects.shellEnv.command.placeholder')}
                aria-label={t('settings.projects.shellEnv.command.label')}
                className="min-h-[56px] w-full font-mono text-xs"
              />
            </div>

            <div>
              <div className="mb-0.5 flex items-center gap-2">
                <p className="typography-meta text-muted-foreground">{t('settings.projects.shellEnv.mode.label')}</p>
                <SettingsInfoHint contentClassName="max-w-xs">
                  {t('settings.projects.shellEnv.mode.info')}
                </SettingsInfoHint>
              </div>
              <Select
                value={draft.mode}
                onValueChange={(value) => updateDraft({ mode: value === SHELL_ENV_MODE_REPLACE ? 'replace' : 'overlay' })}
              >
                <SelectTrigger
                  size={SETTINGS_SELECT_SIZE}
                  className={SETTINGS_SELECT_TRIGGER_CLASS}
                  aria-label={t('settings.projects.shellEnv.mode.label')}
                >
                  <SelectValue>
                    {(value) => value === SHELL_ENV_MODE_REPLACE
                      ? t('settings.projects.shellEnv.mode.replace')
                      : t('settings.projects.shellEnv.mode.overlay')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SHELL_ENV_MODE_OVERLAY}>{t('settings.projects.shellEnv.mode.overlay')}</SelectItem>
                  <SelectItem value={SHELL_ENV_MODE_REPLACE}>{t('settings.projects.shellEnv.mode.replace')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="mb-0.5 flex items-center gap-2">
                <p className="typography-meta text-muted-foreground">{t('settings.projects.shellEnv.vars.label')}</p>
                <SettingsInfoHint contentClassName="max-w-xs">
                  {t('settings.projects.shellEnv.vars.info')}
                </SettingsInfoHint>
              </div>
              <Textarea
                value={draft.varsText}
                onChange={(event) => updateDraft({ varsText: event.target.value })}
                placeholder={t('settings.projects.shellEnv.vars.placeholder')}
                aria-label={t('settings.projects.shellEnv.vars.label')}
                className="min-h-[56px] w-full font-mono text-xs"
              />
              {validationError ? (
                <p className="typography-meta mt-0.5 text-[var(--status-warning)]">{validationError}</p>
              ) : null}
            </div>
          </div>

          <p className="typography-meta text-muted-foreground">
            {t('settings.projects.shellEnv.trustInfo')}
          </p>
        </>
      )}
    </ProjectSettingsSubsection>
  );
};
