import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import type { TrackerAPI, TrackerContainerMapping, TrackerMappingResult, TrackerProviderId } from '@/lib/api/types';
import { trackerSettingsCopy } from './trackerSettingsCopy';

type MappingView = { defaultProjectPath: string | null; containers: TrackerContainerMapping[] };

const toView = (result: TrackerMappingResult): MappingView | null => (
  result.connected ? { defaultProjectPath: result.defaultProjectPath, containers: result.containers } : null
);

const NONE = '__none__';
const INHERIT = '__inherit__';

/**
 * Which OpenChamber project a session started from a tracker item opens in:
 * a default, and optionally one per container (a Linear team). Shown for a
 * connected tracker with `projectMapping`; re-read when the current account
 * changes, because containers belong to the account.
 */
export function TrackerProjectMapping({
  trackers,
  providerId,
  provider,
  accountId,
}: {
  trackers: TrackerAPI;
  providerId: TrackerProviderId;
  /** The tracker's product name, for sentences that name it. */
  provider: string;
  accountId: string | null;
}) {
  const { t } = useI18n();
  const copy = trackerSettingsCopy(providerId).mapping;
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects));
  const [mapping, setMapping] = React.useState<MappingView | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void trackers.mappingGet(providerId).then((result) => {
      if (cancelled) return;
      setMapping(toView(result));
      setLoadFailed(false);
    }).catch(() => {
      if (!cancelled) setLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [accountId, providerId, trackers]);

  const saveMapping = React.useCallback(async (next: MappingView) => {
    const containerProjectPaths: { [containerId: string]: string } = {};
    for (const container of next.containers) {
      if (container.projectPath) {
        containerProjectPaths[container.id] = container.projectPath;
      }
    }
    setIsSaving(true);
    reportSettingsSaveState('saving');
    try {
      const saved = toView(await trackers.mappingSet(providerId, {
        defaultProjectPath: next.defaultProjectPath ?? null,
        containerProjectPaths,
      }));
      if (!saved) {
        setMapping(null);
        reportSettingsSaveState('error');
        return;
      }
      setMapping(saved);
      setLoadFailed(false);
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
    } finally {
      setIsSaving(false);
    }
  }, [providerId, trackers]);

  if (loadFailed && !mapping) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(copy.loadFailed, { provider })}
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
      return t(copy.defaultProjectNone);
    }
    return projectLabel(value);
  };

  const containerProjectLabel = (value: string | undefined) => {
    if (!value || value === INHERIT) {
      return t(copy.containerUseDefault);
    }
    return projectLabel(value);
  };

  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(copy.emptyProjects, { provider })}
        </p>
      ) : null}

      <SettingsFieldRow
        label={t(copy.defaultProject)}
        info={t(copy.defaultProjectInfo, { provider })}
        settingsItem={`integrations.${providerId}.mapping`}
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
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
            aria-label={t(copy.defaultProjectAria, { provider })}
          >
            <SelectValue placeholder={t(copy.defaultProjectNone)}>
              {defaultProjectLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>
              {t(copy.defaultProjectNone)}
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
        title={t(copy.containers)}
        info={t(copy.containersInfo)}
      >
        {mapping.containers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t(copy.emptyContainers, { provider })}
          </p>
        ) : (
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {mapping.containers.map((team) => (
              <SettingsFieldRow
                key={team.id}
                label={team.key ? `${team.key} · ${team.name}` : team.name}
              >
                <Select
                  value={team.projectPath || INHERIT}
                  disabled={isSaving || projects.length === 0}
                  onValueChange={(value) => {
                    void saveMapping({
                      ...mapping,
                      containers: mapping.containers.map((entry) => (
                        entry.id === team.id
                          ? { ...entry, projectPath: value === INHERIT ? null : value }
                          : entry
                      )),
                    });
                  }}
                >
                  <SelectTrigger
                    className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                    aria-label={t(copy.containerAria, { team: team.key ?? team.name, provider })}
                  >
                    <SelectValue placeholder={t(copy.containerUseDefault)}>
                      {containerProjectLabel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {t(copy.containerUseDefault)}
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
