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
import { RiFolderLine, RiRobot2Line, RiUser3Line } from '@remixicon/react';

import type { SkillsCatalogItem } from '@/lib/api/types';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { InstallConflictsDialog, type ConflictDecision, type SkillConflict } from './InstallConflictsDialog';
import {
  SKILL_LOCATION_OPTIONS,
  locationLabel,
  locationPartsFrom,
  locationValueFrom,
  type SkillLocationValue,
} from '../skillLocations';

interface InstallSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: SkillsCatalogItem | null;
}

export const InstallSkillDialog: React.FC<InstallSkillDialogProps> = ({ open, onOpenChange, item }) => {
  const { installSkills, isInstalling } = useSkillsCatalogStore();
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
    skillDir: string;
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
    skillDir: string;
    directoryOverride?: string | null;
    conflictDecisions?: Record<string, ConflictDecision>;
  }) => {
    // Build selection with clawdhub metadata if present
    const selection: { skillDir: string; clawdhub?: { slug: string; version: string } } = {
      skillDir: request.skillDir,
    };
    if (item?.clawdhub) {
      selection.clawdhub = {
        slug: item.clawdhub.slug,
        version: item.clawdhub.version,
      };
    }

    const result = await installSkills({
      source: request.source,
      subpath: request.subpath,
      gitIdentityId: item?.gitIdentityId,
      scope: request.scope,
      targetSource: request.targetSource,
      selections: [selection],
      conflictPolicy: 'prompt',
      conflictDecisions: request.conflictDecisions,
    }, { directory: request.directoryOverride ?? null });

    if (result.ok) {
      toast.success('Skill installed successfully');
      onOpenChange(false);
      return;
    }

    if (result.error?.kind === 'conflicts') {
      setBaseRequest({
        source: request.source,
        subpath: request.subpath,
        scope: request.scope,
        targetSource: request.targetSource,
        skillDir: request.skillDir,
        directoryOverride: request.directoryOverride ?? null,
      });
      setConflicts(result.error.conflicts);
      setConflictsOpen(true);
      return;
    }

    if (result.error?.kind === 'authRequired') {
      toast.error(result.error.message || 'Authentication required');
      return;
    }

    toast.error(result.error?.message || 'Failed to install skill');
  };

  if (!item) {
    return null;
  }

  // computed inline in UI; keep vars minimal
  const targetProjectLabel = (() => {
    if (scope !== 'project') {
      return null;
    }
    const id = resolvedTargetProjectId;
    if (!id) {
      return null;
    }
    const project = projects.find((p) => p.id === id);
    return project?.label || project?.path || null;
  })();


  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg" keyboardAvoid>
          <DialogHeader>
            <DialogTitle>Install skill</DialogTitle>
            <DialogDescription>
              Install <span className="font-semibold text-foreground">{item.skillName}</span> into one of four target locations.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 space-y-2">
            <div className="rounded-lg px-2 py-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="typography-ui-label font-medium text-foreground">Destination</span>
                    <span className="typography-meta text-muted-foreground truncate">
                      {locationLabel(scope, targetSource)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-2 pl-0 pr-1 pb-1">
                <Select
                  value={locationValueFrom(scope, targetSource)}
                  onValueChange={(v) => {
                    const next = locationPartsFrom(v as SkillLocationValue);
                    setScope(next.scope);
                    setTargetSource(next.source === 'agents' ? 'agents' : 'opencode');
                  }}
                >
                  <SelectTrigger size="lg" className="w-full justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      {scope === 'user' ? <RiUser3Line className="h-4 w-4" /> : <RiFolderLine className="h-4 w-4" />}
                      {targetSource === 'agents' ? <RiRobot2Line className="h-4 w-4" /> : null}
                      <span className="min-w-0 truncate">{locationLabel(scope, targetSource)}</span>
                    </span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    {SKILL_LOCATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="pr-2 [&>span:first-child]:hidden">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            {option.scope === 'user' ? <RiUser3Line className="h-4 w-4" /> : <RiFolderLine className="h-4 w-4" />}
                            {option.source === 'agents' ? <RiRobot2Line className="h-4 w-4" /> : null}
                            <span>{option.label}</span>
                          </div>
                          <span className="typography-micro text-muted-foreground ml-6">{option.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scope === 'project' ? (
              <div className="rounded-lg px-2 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="typography-ui-label font-medium text-foreground">Project</span>
                      <span className="typography-meta text-muted-foreground truncate">{targetProjectLabel || 'Choose'}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-2 pl-0 pr-1 pb-1">
                  {projects.length === 0 ? (
                    <div className="h-9 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-2 flex items-center typography-meta text-muted-foreground">
                      No projects available
                    </div>
                  ) : (
                    <Select
                      value={resolvedTargetProjectId ?? ''}
                      onValueChange={(v) => setTargetProjectId(v)}
                      disabled={projects.length === 1}
                    >
                      <SelectTrigger size="lg" className="w-full justify-between">
                        <SelectValue placeholder="Choose project" />
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
              </div>
            ) : null}

            {item.warnings?.length ? (
              <div className="rounded-lg border bg-[var(--surface-elevated)] px-3 py-2">
                <div className="typography-micro text-muted-foreground">Warnings</div>
                <ul className="mt-1 space-y-1">
                  {item.warnings.map((w) => (
                    <li key={w} className="typography-meta text-muted-foreground">{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <DialogFooter className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="default"
              disabled={isInstalling || !item.installable || (scope === 'project' && !directoryOverride)}
              onClick={() =>
                void doInstall({
                  source: item.repoSource,
                  subpath: item.repoSubpath,
                  scope,
                  targetSource,
                  skillDir: item.skillDir,
                  directoryOverride,
                })
              }
            >
              {isInstalling ? 'Installing…' : 'Install'}
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
            skillDir: baseRequest.skillDir,
            conflictDecisions: decisions,
            directoryOverride: baseRequest.directoryOverride ?? null,
          });
          setConflictsOpen(false);
        }}
      />
    </>
  );
};
