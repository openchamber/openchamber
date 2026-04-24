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
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RiFolderLine, RiGitRepositoryLine, RiRobot2Line, RiUser3Line } from '@remixicon/react';

import { isVSCodeRuntime } from '@/lib/desktop';
import type { SkillsCatalogItem } from '@/lib/api/types';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { InstallConflictsDialog, type ConflictDecision, type SkillConflict } from './InstallConflictsDialog';
import { useI18n } from '@/lib/i18n';
import {
  SKILL_LOCATION_OPTIONS,
  locationPartsFrom,
  locationValueFrom,
  type SkillLocationValue,
} from '../skillLocations';

interface InstallFromRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type IdentityOption = { id: string; name: string };

export const InstallFromRepoDialog: React.FC<InstallFromRepoDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const { scanRepo, installSkills, isScanning, isInstalling } = useSkillsCatalogStore();
  const installedSkills = useSkillsStore((s) => s.skills);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);

  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const [targetProjectId, setTargetProjectId] = React.useState<string | null>(null);

  const [source, setSource] = React.useState('');
  const [subpath, setSubpath] = React.useState('');
  const [scope, setScope] = React.useState<'user' | 'project'>('user');
  const [targetSource, setTargetSource] = React.useState<'opencode' | 'agents'>('opencode');

  const [items, setItems] = React.useState<SkillsCatalogItem[]>([]);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [search, setSearch] = React.useState('');

  const [identities, setIdentities] = React.useState<IdentityOption[]>([]);
  const [gitIdentityId, setGitIdentityId] = React.useState<string | null>(null);

  const [conflictsOpen, setConflictsOpen] = React.useState(false);
  const [conflicts, setConflicts] = React.useState<SkillConflict[]>([]);
  const [baseInstallRequest, setBaseInstallRequest] = React.useState<{
    source: string;
    subpath?: string;
    scope: 'user' | 'project';
    targetSource: 'opencode' | 'agents';
    selections: Array<{ skillDir: string }>;
    gitIdentityId?: string;
    directoryOverride?: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setSource('');
    setSubpath('');
    setScope('user');
    setTargetSource('opencode');
    setTargetProjectId(activeProjectId);
    setItems([]);
    setSelected({});
    setSearch('');
    setIdentities([]);
    setGitIdentityId(null);
    void loadDefaultGitIdentityId();

    setConflictsOpen(false);

    setConflicts([]);
    setBaseInstallRequest(null);
  }, [open, loadDefaultGitIdentityId, activeProjectId]);

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

  const installedByName = React.useMemo(() => {
    const map = new Map<string, { scope: 'user' | 'project'; source: 'opencode' | 'claude' | 'agents' }>();
    for (const s of installedSkills) {
      map.set(s.name, { scope: s.scope, source: s.source });
    }
    return map;
  }, [installedSkills]);

  const filteredItems = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const name = item.skillName.toLowerCase();
      const desc = (item.description || '').toLowerCase();
      const fm = (item.frontmatterName || '').toLowerCase();
      return name.includes(q) || desc.includes(q) || fm.includes(q);
    });
  }, [items, search]);

  const selectedDirs = React.useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  const toggleAll = (value: boolean) => {
    const next: Record<string, boolean> = {};
    for (const item of items) {
      if (!item.installable) continue;
      next[item.skillDir] = value;
    }
    setSelected(next);
  };

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

  const handleScan = async () => {
    const trimmed = source.trim();
    if (!trimmed) {
      toast.error(t('settings.skills.catalog.shared.toast.repositoryRequired'));
      return;
    }

    const result = await scanRepo({
      source: trimmed,
      subpath: subpath.trim() || undefined,
      gitIdentityId: gitIdentityId || undefined,
    });

    if (!result.ok) {
      if (result.error?.kind === 'authRequired') {
        if (isVSCodeRuntime()) {
          toast.error(t('settings.skills.catalog.shared.toast.privateRepoNotSupportedVsCode'));
          return;
        }

        const ids = (result.error.identities || []) as IdentityOption[];
        setIdentities(ids);
        if (!gitIdentityId && ids.length > 0) {
          const preferred =
            defaultGitIdentityId &&
            defaultGitIdentityId !== 'global' &&
            ids.some((i) => i.id === defaultGitIdentityId)
              ? defaultGitIdentityId
              : ids[0].id;
          setGitIdentityId(preferred);
        }
        toast.error(t('settings.skills.catalog.installFromRepo.toast.authenticationRequiredScan'));
        return;
      }

      toast.error(result.error?.message || t('settings.skills.catalog.installFromRepo.toast.scanFailed'));
      return;
    }

    const nextItems = result.items || [];
    setItems(nextItems);

    // Auto-select all installable items when scanning returns a small set.
    const nextSelected: Record<string, boolean> = {};
    for (const item of nextItems) {
      if (item.installable) {
        nextSelected[item.skillDir] = true;
      }
    }
    setSelected(nextSelected);

    setIdentities([]);
    toast.success(t('settings.skills.catalog.shared.toast.foundSkills', { count: nextItems.length }));
  };

  const doInstall = async (opts: { conflictDecisions?: Record<string, ConflictDecision> }) => {
    if (selectedDirs.length === 0) {
      toast.error(t('settings.skills.catalog.installFromRepo.toast.selectAtLeastOne'));
      return;
    }

    const request = {
      source: source.trim(),
      subpath: subpath.trim() || undefined,
      scope,
      targetSource,
      selections: selectedDirs.map((dir) => ({ skillDir: dir })),
      gitIdentityId: gitIdentityId || undefined,
      directoryOverride,
    };

    const result = await installSkills(
      {
        source: request.source,
        subpath: request.subpath,
        scope: request.scope,
        targetSource: request.targetSource,
        selections: request.selections,
        gitIdentityId: request.gitIdentityId,
        conflictPolicy: 'prompt',
        conflictDecisions: opts.conflictDecisions,
      },
      { directory: request.directoryOverride ?? null }
    );

    if (result.ok) {
      const installedCount = result.installed?.length || 0;
      toast.success(
        installedCount > 0
          ? t('settings.skills.catalog.installFromRepo.toast.installedCount', { count: installedCount })
          : t('settings.skills.catalog.installFromRepo.toast.installCompleted')
      );
      onOpenChange(false);
      return;
    }

    if (result.error?.kind === 'conflicts') {
      setBaseInstallRequest(request);
      setConflicts(result.error.conflicts);
      setConflictsOpen(true);
      return;
    }

    if (result.error?.kind === 'authRequired') {
      if (isVSCodeRuntime()) {
        toast.error(t('settings.skills.catalog.shared.toast.privateRepoNotSupportedVsCode'));
        return;
      }
      const ids = (result.error.identities || []) as IdentityOption[];
      setIdentities(ids);
      if (!gitIdentityId && ids.length > 0) {
        const preferred =
          defaultGitIdentityId &&
          defaultGitIdentityId !== 'global' &&
          ids.some((i) => i.id === defaultGitIdentityId)
            ? defaultGitIdentityId
            : ids[0].id;
        setGitIdentityId(preferred);
      }
      toast.error(t('settings.skills.catalog.installFromRepo.toast.authenticationRequiredInstall'));
      return;
    }

    toast.error(result.error?.message || t('settings.skills.catalog.installFromRepo.toast.installFailed'));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{t('settings.skills.catalog.installFromRepo.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.catalog.installFromRepo.descriptionPrefix')}
              {' '}
              <code className="font-mono">SKILL.md</code>
              {t('settings.skills.catalog.installFromRepo.descriptionSuffix')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-shrink-0">
            <div className="space-y-2">
              <label className="typography-ui-label font-medium text-foreground">{t('settings.skills.catalog.shared.field.repository')}</label>
              <div className="flex items-center gap-2">
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={t('settings.skills.catalog.shared.field.repositoryPlaceholder')}
                  className="text-foreground placeholder:text-muted-foreground"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleScan()}
                  disabled={isScanning || !source.trim()}
                  className="gap-2"
                >
                  <RiGitRepositoryLine className="h-4 w-4" />
                  {isScanning ? t('settings.skills.catalog.shared.actions.scanning') : t('settings.skills.catalog.shared.actions.scan')}
                </Button>
              </div>
              <p className="typography-meta text-muted-foreground">
                {t('settings.skills.catalog.installFromRepo.repositoryHintPrefix')}
                {' '}
                <code className="font-mono">owner/repo/skills</code>
                {'.'}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="typography-ui-label font-medium text-foreground">{t('settings.skills.catalog.shared.field.optionalSubpath')}</label>
                <Input
                  value={subpath}
                  onChange={(e) => setSubpath(e.target.value)}
                  placeholder={t('settings.skills.catalog.shared.field.subpathPlaceholder')}
                  className="text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <label className="typography-ui-label font-medium text-foreground">{t('settings.skills.catalog.shared.field.targetLocation')}</label>
                <Select
                  value={locationValueFrom(scope, targetSource)}
                  onValueChange={(v) => {
                    const next = locationPartsFrom(v as SkillLocationValue);
                    setScope(next.scope);
                    setTargetSource(next.source === 'agents' ? 'agents' : 'opencode');
                  }}
                >
                  <SelectTrigger size="lg" className="w-full gap-1.5">
                    {scope === 'user' ? <RiUser3Line className="h-4 w-4" /> : <RiFolderLine className="h-4 w-4" />}
                    {targetSource === 'agents' ? <RiRobot2Line className="h-4 w-4" /> : null}
                    <span>{locationLabelText(locationValueFrom(scope, targetSource))}</span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    {SKILL_LOCATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="pr-2 [&>span:first-child]:hidden">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            {option.scope === 'user' ? <RiUser3Line className="h-4 w-4" /> : <RiFolderLine className="h-4 w-4" />}
                            {option.source === 'agents' ? <RiRobot2Line className="h-4 w-4" /> : null}
                            <span>{locationLabelText(option.value)}</span>
                          </div>
                          <span className="typography-micro text-muted-foreground ml-6">{locationDescriptionText(option.value)}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scope === 'project' && (
              <div className="space-y-2">
                <label className="typography-ui-label font-medium text-foreground">{t('settings.skills.catalog.shared.field.project')}</label>
                {projects.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.skills.catalog.shared.field.noProjects')}</p>
                ) : (
                  <Select
                    value={resolvedTargetProjectId ?? ''}
                    onValueChange={(v) => setTargetProjectId(v)}
                    disabled={projects.length === 1}
                  >
                    <SelectTrigger size="lg" className="w-full justify-between">
                      <SelectValue placeholder={t('settings.skills.catalog.shared.field.chooseProjectPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="pr-2 [&>span:first-child]:hidden">
                          {p.label || p.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {identities.length > 0 && !isVSCodeRuntime() ? (
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="typography-ui-label font-medium text-foreground">{t('settings.skills.catalog.shared.auth.title')}</div>
                <div className="typography-meta text-muted-foreground mt-1">
                  {t('settings.skills.catalog.installFromRepo.authDescription')}
                </div>
                <div className="mt-2">
                  <Select value={gitIdentityId || ''} onValueChange={(v) => setGitIdentityId(v)}>
                    <SelectTrigger size="lg" className="w-full justify-between">
                      <span>{identities.find((i) => i.id === gitIdentityId)?.name || t('settings.skills.catalog.shared.auth.chooseIdentity')}</span>
                    </SelectTrigger>
                    <SelectContent align="start">
                      {identities.map((id) => (
                        <SelectItem key={id.id} value={id.id} className="pr-2 [&>span:first-child]:hidden">
                          {id.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="typography-micro text-muted-foreground mt-2">
                  {t('settings.skills.catalog.shared.auth.footerHintArrow')}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-h-0">
            {items.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-muted-foreground">
                <div>
                  <p className="typography-body">{t('settings.skills.catalog.installFromRepo.empty.noScanResultsTitle')}</p>
                  <p className="typography-meta mt-1 opacity-75">{t('settings.skills.catalog.installFromRepo.empty.noScanResultsDescription')}</p>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('settings.skills.catalog.shared.field.searchSkillsPlaceholder')}
                    className="max-w-sm"
                  />
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => toggleAll(true)}>{t('settings.skills.catalog.installFromRepo.actions.selectAll')}</Button>
                    <Button variant="outline" size="sm" onClick={() => toggleAll(false)}>{t('settings.skills.catalog.installFromRepo.actions.selectNone')}</Button>
                  </div>
                </div>

                <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-2">
                  {filteredItems.map((item) => {
                    const installed = installedByName.get(item.skillName);
                    const checked = Boolean(selected[item.skillDir]);
                    const disabled = !item.installable;

                    return (
                      <label
                        key={item.skillDir}
                        className={
                          'flex items-start gap-3 rounded-lg border bg-muted/10 px-3 py-2 cursor-pointer transition-colors ' +
                          (disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-interactive-hover/20')
                        }
                      >
                        <div className="mt-1">
                          <Checkbox
                            checked={checked}
                            disabled={disabled}
                            onChange={(newChecked) => setSelected((prev) => ({ ...prev, [item.skillDir]: newChecked }))}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="typography-ui-label truncate">{item.skillName}</div>
                            {installed ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                                {t('settings.skills.catalog.installFromRepo.badge.installed', {
                                  scope: installed.scope,
                                  source: installed.source,
                                })}
                              </span>
                            ) : null}
                          </div>
                          {item.description ? (
                            <div className="typography-meta text-muted-foreground mt-0.5 line-clamp-2">{item.description}</div>
                          ) : (
                            <div className="typography-micro text-muted-foreground mt-0.5">{t('settings.skills.catalog.shared.noDescription')}</div>
                          )}
                          {item.warnings?.length ? (
                            <div className="typography-micro text-muted-foreground mt-1">
                              {item.warnings.join(' · ')}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </ScrollableOverlay>

                <div className="typography-meta text-muted-foreground">
                  {t('settings.skills.catalog.installFromRepo.selectedCount', {
                    selected: selectedDirs.length,
                    total: items.filter((i) => i.installable).length,
                  })}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-shrink-0">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={isInstalling || selectedDirs.length === 0 || !source.trim() || (scope === 'project' && !directoryOverride)}
              onClick={() => void doInstall({})}
            >
              {isInstalling ? t('settings.skills.catalog.shared.actions.installing') : t('settings.skills.catalog.installFromRepo.actions.installSelected')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InstallConflictsDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
        conflicts={conflicts}
        onConfirm={(decisions) => {
          if (!baseInstallRequest) {
            setConflictsOpen(false);
            return;
          }
          void doInstall({ conflictDecisions: decisions });
          setConflictsOpen(false);
        }}
      />
    </>
  );
};
