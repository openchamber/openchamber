import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { LinearAPI, LinearMappingResult } from '@/lib/api/types';

const NONE = '__none__';
const INHERIT = '__inherit__';

export function LinearProjectMapping({
  linear,
  connected,
  organizationId,
}: {
  linear: LinearAPI;
  connected: boolean;
  organizationId?: string | null;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const [mapping, setMapping] = React.useState<LinearMappingResult | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  const loadMapping = React.useCallback(async () => {
    if (!connected) {
      setMapping(null);
      setLoadFailed(false);
      return;
    }
    try {
      const next = await linear.mappingGet();
      if (next.connected === false) {
        setMapping(null);
        setLoadFailed(false);
        return;
      }
      setMapping(next);
      setLoadFailed(false);
    } catch (error) {
      console.error('Failed to load Linear mapping:', error);
      setLoadFailed(true);
    }
  }, [connected, linear, organizationId]);

  React.useEffect(() => {
    void loadMapping();
  }, [loadMapping]);

  const saveMapping = React.useCallback(async (next: LinearMappingResult) => {
    const teamProjectPaths: { [teamId: string]: string } = {};
    for (const team of next.teams ?? []) {
      if (team.projectPath) {
        teamProjectPaths[team.id] = team.projectPath;
      }
    }
    setIsSaving(true);
    reportSettingsSaveState('saving');
    try {
      const saved = await linear.mappingSet({
        defaultProjectPath: next.defaultProjectPath ?? null,
        teamProjectPaths,
      });
      if (saved.connected === false) {
        setMapping(null);
        reportSettingsSaveState('error');
        return;
      }
      setMapping(saved);
      setLoadFailed(false);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.error('Failed to save Linear mapping:', error);
      reportSettingsSaveState('error');
    } finally {
      setIsSaving(false);
    }
  }, [linear]);

  if (!connected) {
    return null;
  }

  if (loadFailed && !mapping) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('settings.integrations.linear.mapping.loadFailed')}
      </p>
    );
  }

  if (!mapping) {
    return null;
  }

  const projectLabel = (path: string) => {
    const project = projects.find((entry) => entry.path === path);
    return project?.label?.trim() || path;
  };

  const defaultProjectLabel = (value: string | undefined) => {
    if (!value || value === NONE) {
      return t('settings.integrations.linear.mapping.defaultProject.placeholder');
    }
    return projectLabel(value);
  };

  const teamProjectLabel = (value: string | undefined) => {
    if (!value || value === INHERIT) {
      return t('settings.integrations.linear.mapping.teams.useDefault');
    }
    return projectLabel(value);
  };

  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('settings.integrations.linear.mapping.emptyProjects')}
        </p>
      ) : null}

      <SettingsFieldRow
        label={t('settings.integrations.linear.mapping.defaultProject')}
        info={t('settings.integrations.linear.mapping.defaultProject.info')}
        settingsItem="integrations.linear.mapping"
      >
        <Select
          value={mapping.defaultProjectPath || NONE}
          disabled={isSaving || projects.length === 0}
          onValueChange={(value) => {
            void saveMapping({
              ...mapping,
              defaultProjectPath: value === NONE ? null : value,
            });
          }}
        >
          <SelectTrigger
            size={SETTINGS_SELECT_SIZE}
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
            aria-label={t('settings.integrations.linear.mapping.defaultProject.aria')}
          >
            <SelectValue placeholder={t('settings.integrations.linear.mapping.defaultProject.placeholder')}>
              {defaultProjectLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>
              {t('settings.integrations.linear.mapping.defaultProject.placeholder')}
            </SelectItem>
            {mapping.defaultProjectPath && !projects.some((entry) => entry.path === mapping.defaultProjectPath) ? (
              <SelectItem value={mapping.defaultProjectPath}>{mapping.defaultProjectPath}</SelectItem>
            ) : null}
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.path}>
                {projectLabel(project.path)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>

      <SettingsControlGroup
        title={t('settings.integrations.linear.mapping.teams')}
        info={t('settings.integrations.linear.mapping.teams.info')}
      >
        {(mapping.teams ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('settings.integrations.linear.mapping.emptyTeams')}
          </p>
        ) : (
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {(mapping.teams ?? []).map((team) => (
              <SettingsFieldRow
                key={team.id}
                label={`${team.key} · ${team.name}`}
              >
                <Select
                  value={team.projectPath || INHERIT}
                  disabled={isSaving || projects.length === 0}
                  onValueChange={(value) => {
                    void saveMapping({
                      ...mapping,
                      teams: (mapping.teams ?? []).map((entry) => (
                        entry.id === team.id
                          ? { ...entry, projectPath: value === INHERIT ? null : value }
                          : entry
                      )),
                    });
                  }}
                >
                  <SelectTrigger
                    size={SETTINGS_SELECT_SIZE}
                    className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                    aria-label={t('settings.integrations.linear.mapping.teams.aria', { team: team.key })}
                  >
                    <SelectValue placeholder={t('settings.integrations.linear.mapping.teams.useDefault')}>
                      {teamProjectLabel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {t('settings.integrations.linear.mapping.teams.useDefault')}
                    </SelectItem>
                    {team.projectPath && !projects.some((entry) => entry.path === team.projectPath) ? (
                      <SelectItem value={team.projectPath}>{team.projectPath}</SelectItem>
                    ) : null}
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.path}>
                        {projectLabel(project.path)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            ))}
          </div>
        )}
      </SettingsControlGroup>
    </div>
  );
}
