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
import { ButtonLarge } from '@/components/ui/button-large';
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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md" keyboardAvoid>
          <DialogHeader>
            <DialogTitle>Install skill</DialogTitle>
            <DialogDescription>
              Install <span className="font-semibold text-foreground">{item.skillName}</span> into one of four target locations.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="typography-ui-label text-foreground">Destination</span>
              <Select
                value={locationValueFrom(scope, targetSource)}
                onValueChange={(v) => {
                  const next = locationPartsFrom(v as SkillLocationValue);
                  setScope(next.scope);
                  setTargetSource(next.source === 'agents' ? 'agents' : 'opencode');
                }}
              >
                <SelectTrigger className="w-fit gap-1.5">
                  {scope === 'user' ? <RiUser3Line className="h-3.5 w-3.5" /> : <RiFolderLine className="h-3.5 w-3.5" />}
                  {targetSource === 'agents' ? <RiRobot2Line className="h-3.5 w-3.5" /> : null}
                  <span>{locationLabel(scope, targetSource)}</span>
                </SelectTrigger>
                <SelectContent align="start">
                  {SKILL_LOCATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="pr-2 [&>span:first-child]:hidden">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          {option.scope === 'user' ? <RiUser3Line className="h-3.5 w-3.5" /> : <RiFolderLine className="h-3.5 w-3.5" />}
                          {option.source === 'agents' ? <RiRobot2Line className="h-3.5 w-3.5" /> : null}
                          <span>{option.label}</span>
                        </div>
                        <span className="typography-micro text-muted-foreground ml-5">{option.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {scope === 'project' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="typography-ui-label text-foreground">Project</span>
                {projects.length === 0 ? (
                  <span className="typography-meta text-muted-foreground">No projects available</span>
                ) : (
                  <Select
                    value={resolvedTargetProjectId ?? ''}
                    onValueChange={(v) => setTargetProjectId(v)}
                    disabled={projects.length === 1}
                  >
                    <SelectTrigger className="w-fit">
                      <SelectValue placeholder="Choose project" />
                    </SelectTrigger>
                    <SelectContent align="start">
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

            {item.warnings?.length ? (
              <div className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-2 py-1.5 rounded">
                {item.warnings.join(' · ')}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <ButtonLarge
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </ButtonLarge>
            <ButtonLarge
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
              {isInstalling ? 'Installing...' : 'Install'}
            </ButtonLarge>
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
