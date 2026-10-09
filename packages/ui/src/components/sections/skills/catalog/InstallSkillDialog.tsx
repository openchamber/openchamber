import React from 'react';
import { toast } from '@/components/ui';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

import type { SkillsCatalogItem } from '@/lib/api/types';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { InstallConflictsDialog, type ConflictDecision, type SkillConflict } from './InstallConflictsDialog';
import {
  SKILL_LOCATION_OPTIONS,
  locationPartsFrom,
  locationValueFrom,
  type SkillLocationValue,
} from '../skillLocations';

interface InstallSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SkillsCatalogItem[];
}

export const InstallSkillDialog: React.FC<InstallSkillDialogProps> = ({ open, onOpenChange, items }) => {
  const { t } = useI18n();
  const installSkills = useSkillsCatalogStore((s) => s.installSkills);
  const loadSource = useSkillsCatalogStore((s) => s.loadSource);
  const isInstalling = useSkillsCatalogStore((s) => s.isInstalling);
  const [scope, setScope] = React.useState<'user' | 'project'>('user');
  const [targetSource, setTargetSource] = React.useState<'opencode' | 'agents'>('opencode');
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const [targetProjectId, setTargetProjectId] = React.useState<string | null>(null);
  const [conflictsOpen, setConflictsOpen] = React.useState(false);
  const [conflicts, setConflicts] = React.useState<SkillConflict[]>([]);
  const [baseRequest, setBaseRequest] = React.useState<{
    source: string;
    subpath?: string;
    scope: 'user' | 'project';
    targetSource: 'opencode' | 'agents';
    skillDirs: string[];
    directoryOverride?: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setScope('user');
    setTargetSource('opencode');
    setTargetProjectId(activeProjectId);
    setConflictsOpen(false);
    setConflicts([]);
    setBaseRequest(null);
  }, [open, activeProjectId]);

  const locationLabelText = React.useCallback((value: SkillLocationValue) => {
    switch (value) {
      case 'project-opencode':
        return t('settings.skills.location.option.projectOpencode.label');
      case 'user-agents':
        return t('settings.skills.location.option.userAgents.label');
      case 'project-agents':
        return t('settings.skills.location.option.projectAgents.label');
      default:
        return t('settings.skills.location.option.userOpencode.label');
    }
  }, [t]);

  const locationDescriptionText = React.useCallback((value: SkillLocationValue) => {
    switch (value) {
      case 'project-opencode':
        return t('settings.skills.location.option.projectOpencode.description');
      case 'user-agents':
        return t('settings.skills.location.option.userAgents.description');
      case 'project-agents':
        return t('settings.skills.location.option.projectAgents.description');
      default:
        return t('settings.skills.location.option.userOpencode.description');
    }
  }, [t]);

  const resolvedTargetProjectId = React.useMemo(() => {
    if (projects.length === 0) {
      return null;
    }
    if (targetProjectId && projects.some((p) => p.id === targetProjectId)) {
      return targetProjectId;
    }
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) {
      return activeProjectId;
    }
    return projects[0]?.id ?? null;
  }, [activeProjectId, projects, targetProjectId]);

  const directoryOverride = React.useMemo(() => {
    if (scope !== 'project') {
      return null;
    }
    const id = resolvedTargetProjectId;
    if (!id) {
      return null;
    }
    const project = projects.find((p) => p.id === id);
    return project?.path ?? null;
  }, [projects, resolvedTargetProjectId, scope]);

  const doInstall = async (request: {
    source: string;
    subpath?: string;
    scope: 'user' | 'project';
    targetSource: 'opencode' | 'agents';
    skillDirs: string[];
    directoryOverride?: string | null;
    conflictDecisions?: Record<string, ConflictDecision>;
  }) => {
    const result = await installSkills({
      source: request.source,
      subpath: request.subpath,
      gitIdentityId: items[0]?.gitIdentityId,
      scope: request.scope,
      targetSource: request.targetSource,
      selections: request.skillDirs.map((skillDir) => ({ skillDir })),
      conflictPolicy: 'prompt',
      conflictDecisions: request.conflictDecisions,
    }, { directory: request.directoryOverride ?? null });

    if (result.ok) {
      const skipped = result.skipped ?? [];
      if (skipped.length > 0) {
        toast.warning(t('settings.skills.catalog.installSkill.toast.skipped', {
          skills: skipped.map((entry) => `${entry.skillName} (${entry.reason})`).join(', '),
        }));
      } else {
        toast.success(t('settings.skills.catalog.installSkill.toast.installed'));
      }
      onOpenChange(false);
      await Promise.all([...new Set(items.map((item) => item.sourceId))].map((sourceId) => loadSource(sourceId, { refresh: true })));
      return;
    }

    if (result.error?.kind === 'conflicts') {
      setBaseRequest({
        source: request.source,
        subpath: request.subpath,
        scope: request.scope,
        targetSource: request.targetSource,
        skillDirs: request.skillDirs,
        directoryOverride: request.directoryOverride ?? null,
      });
      setConflicts(result.error.conflicts);
      setConflictsOpen(true);
      return;
    }

    if (result.error?.kind === 'authRequired') {
      toast.error(result.error.message || t('settings.skills.catalog.installSkill.toast.authRequired'));
      return;
    }

    toast.error(result.error?.message || t('settings.skills.catalog.installSkill.toast.installFailed'));
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{items.length === 1 ? t('settings.skills.catalog.installSkill.title') : t('settings.skills.catalog.installFromRepo.title')}</DialogTitle>
            <DialogDescription>
              {items.length === 1 ? (
                <>
                  {t('settings.skills.catalog.installSkill.descriptionPrefix')}
                  {' '}
                  <span className="font-semibold text-foreground">{items[0].skillName}</span>
                  {' '}
                  {t('settings.skills.catalog.installSkill.descriptionSuffix')}
                </>
              ) : t('settings.skills.catalog.installFromRepo.selectedCount', { selected: items.length, total: items.length })}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="typography-ui-label text-foreground">{t('settings.skills.catalog.installSkill.field.destination')}</span>
              <Select
                value={locationValueFrom(scope, targetSource)}
                onValueChange={(v) => {
                  const selectedLocation = SKILL_LOCATION_OPTIONS.find((option) => option.value === v);
                  if (!selectedLocation) return;
                  const next = locationPartsFrom(selectedLocation.value);
                  setScope(next.scope);
                  setTargetSource(next.source === 'agents' ? 'agents' : 'opencode');
                }}
              >
                <SelectTrigger className="w-fit gap-1.5">
                  {scope === 'user' ? <Icon name="user-3" className="h-3.5 w-3.5" /> : <Icon name="folder" className="h-3.5 w-3.5" />}
                  {targetSource === 'agents' ? <Icon name="robot-2" className="h-3.5 w-3.5" /> : null}
                  <span>{locationLabelText(locationValueFrom(scope, targetSource))}</span>
                </SelectTrigger>
                <SelectContent align="start" portalToBody>
                  {SKILL_LOCATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="pr-2 [&>span:first-child]:hidden">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          {option.scope === 'user' ? <Icon name="user-3" className="h-3.5 w-3.5" /> : <Icon name="folder" className="h-3.5 w-3.5" />}
                          {option.source === 'agents' ? <Icon name="robot-2" className="h-3.5 w-3.5" /> : null}
                          <span>{locationLabelText(option.value)}</span>
                        </div>
                        <span className="typography-micro text-muted-foreground ml-5">{locationDescriptionText(option.value)}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {scope === 'project' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="typography-ui-label text-foreground">{t('settings.skills.catalog.installSkill.field.project')}</span>
                {projects.length === 0 ? (
                  <span className="typography-meta text-muted-foreground">{t('settings.skills.catalog.installSkill.field.noProjects')}</span>
                ) : (
                  <Select
                    value={resolvedTargetProjectId ?? ''}
                    onValueChange={(v) => setTargetProjectId(v)}
                    disabled={projects.length === 1}
                  >
                    <SelectTrigger className="w-fit">
                      <SelectValue placeholder={t('settings.skills.catalog.installSkill.field.chooseProjectPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent align="start" portalToBody>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label || p.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {items.flatMap((item) => item.warnings ?? []).length ? (
              <div className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-2 py-1.5 rounded">
                {items.flatMap((item) => item.warnings ?? []).join(' · ')}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={isInstalling || items.some((item) => !item.installable) || (scope === 'project' && !directoryOverride)}
              onClick={() =>
                void doInstall({
                  source: items[0].repoSource,
                  subpath: items[0].repoSubpath,
                  scope,
                  targetSource,
                  skillDirs: items.map((item) => item.skillDir),
                  directoryOverride,
                })
              }
            >
              {isInstalling ? t('settings.skills.catalog.installSkill.actions.installing') : t('settings.skills.catalog.installSkill.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InstallConflictsDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
        conflicts={conflicts}
        onConfirm={(decisions) => {
          if (!baseRequest) return;
          void doInstall({
            source: baseRequest.source,
            subpath: baseRequest.subpath,
            scope: baseRequest.scope,
            targetSource: baseRequest.targetSource,
            skillDirs: baseRequest.skillDirs,
            conflictDecisions: decisions,
            directoryOverride: baseRequest.directoryOverride ?? null,
          });
          setConflictsOpen(false);
        }}
      />
    </>
  );
};
