import React from 'react';
import { RiCheckLine, RiDeleteBinLine, RiFolder6Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { PROJECT_ICONS, PROJECT_ICON_MAP, ProjectIconImage, iconBackgroundForProjectColor, resolveProjectColor } from '@/lib/projectMeta';
import { COLOR_PRESETS } from '@/lib/colorPresets';
import { cn } from '@/lib/utils';
import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { spacesOfProject, useSpacesJourneyRead } from '@/lib/spaces/spaces-store';
import { useGitStore } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { useWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';

import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';

type MobileEditableProject = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

const NO_WORKTREES: readonly WorktreeMetadata[] = [];

type MobileProjectEditSurfaceProps = {
  open: boolean;
  project: MobileEditableProject | null;
  onClose: () => void;
};

/**
 * The project's isolated spaces on the phone, where the desktop has the spaces page of the project
 * menu (journey step 9): the same rows, whose actions open the space's sheet. A
 * space is made from the new-session picker, so there is no create button here.
 */
const MobileProjectSpaces: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const { t } = useI18n();
  const { journey } = useSpacesJourneyRead();
  const spaces = journey ? spacesOfProject(journey, projectPath) : [];
  return (
    <div className="flex flex-col gap-2">
      <label className="typography-ui-label font-medium text-foreground">{t('mobile.projectEdit.spacesTitle')}</label>
      {journey !== null && spaces.length === 0 ? <p className="typography-meta text-muted-foreground">{t('spaces.page.empty')}</p> : null}
      {spaces.map((entry) => <SpaceRow key={entry.id} entry={entry} actions="sheet" />)}
    </div>
  );
};

const normalizePath = (value: string | null | undefined): string => normalizePathImpl(value) ?? '';

/** One of the project's worktrees, with its Delete. They follow the sidebar's order: by activity, not by hand. */
const WorktreeRow: React.FC<{
  worktree: WorktreeMetadata;
  onDelete: () => void;
}> = ({ worktree, onDelete }) => {
  const { t } = useI18n();
  const label = worktree.branch || worktree.label || worktree.path;
  const removing = useWorktreeRemoving(worktree.path);
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-2xl border border-border/70 bg-[var(--surface-elevated)] py-1.5 ps-3 pe-1.5 transition-colors',
        removing && 'opacity-60',
      )}
      aria-busy={removing || undefined}
    >
      {removing ? (
        <span className="inline-flex shrink-0 text-muted-foreground" role="status" aria-label={t('sessions.sidebar.group.worktreeRemoving')}>
          <Icon name="loader-4" className="size-4 animate-spin" />
        </span>
      ) : (
        <Icon name="node-tree" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{label}</span>
      {removing ? null : (
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          aria-label={t('mobile.projectEdit.deleteWorktreeAria', { label })}
          onClick={onDelete}
          style={{ touchAction: 'manipulation' }}
        >
          <RiDeleteBinLine className="size-4" />
        </button>
      )}
    </div>
  );
};

export const MobileProjectEditSurface: React.FC<MobileProjectEditSurfaceProps> = ({
  open,
  project,
  onClose,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  // Read the live icon image from the store so discover/remove reflect instantly.
  const currentIconImage = useProjectsStore((state) =>
    project ? state.projects.find((entry) => entry.id === project.id)?.iconImage ?? null : null,
  );

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<WorktreeMetadata | null>(null);

  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
    setIcon(project.icon ?? null);
    setColor(project.color ?? null);
    // Re-seed only when the edited project or sheet visibility changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const projectPath = normalizePath(project?.path);
  const worktrees = useSessionUIStore((state) => (projectPath ? state.availableWorktreesByProject.get(projectPath) : undefined)) ?? NO_WORKTREES;
  const isGitRepo = useGitStore((state) => (projectPath ? state.directories.get(projectPath)?.isGitRepo : undefined)) ?? worktrees.length > 0;

  const handleSave = () => {
    if (!project) return;
    const trimmed = name.trim();
    const meta: Parameters<typeof updateProjectMeta>[1] = { label: trimmed || project.label, icon, color };
    // An image icon sits on the project colour, as in Settings.
    if (color !== (project.color ?? null)) meta.iconBackground = iconBackgroundForProjectColor(color);
    updateProjectMeta(project.id, meta);
    onClose();
  };

  const handleDiscoverIcon = () => {
    if (!project || isDiscovering) return;
    setIsDiscovering(true);
    void discoverProjectIcon(project.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || t('projectEditDialog.toast.failedToDiscoverIcon'));
          return;
        }
        if (result.skipped) {
          toast.success(t('projectEditDialog.toast.customIconAlreadySet'));
          return;
        }
        toast.success(t('projectEditDialog.toast.iconDiscovered'));
      })
      .finally(() => setIsDiscovering(false));
  };

  const handleRemoveDiscoveredIcon = () => {
    if (!project) return;
    void removeProjectIcon(project.id).then((result) => {
      if (!result.ok) {
        toast.error(result.error || t('projectEditDialog.toast.failedToRemoveIcon'));
        return;
      }
      toast.success(t('projectEditDialog.toast.iconRemoved'));
    });
  };

  const currentColorVar = resolveProjectColor(color);
  const previewIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const hasImageIcon = Boolean(currentIconImage);

  return (
    <>
      <MobileFullscreenSurface
        open={open}
        onClose={onClose}
        title={t('projectEditDialog.title')}
        ariaLabel={t('projectEditDialog.title')}
        noHeaderBorder
        trailing={
          <Button
            type="button"
            variant="default"
            size="sm"
            aria-label={t('projectEditDialog.actions.save')}
            onClick={handleSave}
            disabled={!name.trim()}
            style={{ touchAction: 'manipulation' }}
          >
            <RiCheckLine className="size-4" />
            {t('projectEditDialog.actions.save')}
          </Button>
        }
      >
        {project ? (
          <div className="h-full space-y-6 overflow-y-auto px-4 pb-8 pt-2">
            {/* Icon preview */}
            <div className="flex justify-center pt-2">
              <span
                className="flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-muted)] text-muted-foreground"
                style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
              >
                {hasImageIcon ? (
                  <ProjectIconImage
                    project={{ id: project.id, iconImage: currentIconImage }}
                    options={{
                      themeVariant: currentTheme.metadata.variant,
                      iconColor: currentTheme.colors.surface.foreground,
                    }}
                    className="size-full object-contain"
                    fallback={<RiFolder6Line className="size-7" />}
                  />
                ) : previewIconName ? (
                  <Icon name={previewIconName} className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
                ) : (
                  <RiFolder6Line className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
                )}
              </span>
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.name')}
              </label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('projectEditDialog.field.namePlaceholder')}
                className="h-11"
              />
              <p className="truncate typography-meta text-muted-foreground" title={project.path}>
                {project.path}
              </p>
            </div>

            {/* Color */}
            <div className="flex flex-col gap-2">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.color')}
              </label>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  aria-label={t('projectEditDialog.option.none')}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                    color === null ? 'border-foreground' : 'border-border/70 hover:border-border/70',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
                </button>
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setColor(preset)}
                    aria-label={t('settings.projects.appearance.colorSwatchAria', { color: preset })}
                    title={preset}
                    className={cn(
                      'size-9 rounded-xl border-2 transition-all',
                      color === preset ? 'border-foreground' : 'border-transparent hover:border-border/70',
                    )}
                    style={{ backgroundColor: preset, touchAction: 'manipulation' }}
                  />
                ))}
              </div>
            </div>

            {/* Icon */}
            <div className="flex flex-col gap-2">
              <label className="typography-ui-label font-medium text-foreground">
                {t('projectEditDialog.field.icon')}
              </label>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  aria-label={t('projectEditDialog.option.none')}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                    icon === null ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border/70 hover:border-border/70',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
                </button>
                {PROJECT_ICONS.map((i) => (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => setIcon(i.key)}
                    aria-label={i.label}
                    title={i.label}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                      icon === i.key ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border/70 hover:border-border/70',
                    )}
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Icon name={i.Icon} className="size-4" style={currentColorVar ? { color: currentColorVar } : undefined} />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleDiscoverIcon} disabled={isDiscovering}>
                  {isDiscovering
                    ? t('projectEditDialog.actions.discovering')
                    : t('projectEditDialog.actions.discoverFavicon')}
                </Button>
                {hasImageIcon ? (
                  <Button size="sm" variant="outline" onClick={handleRemoveDiscoveredIcon}>
                    {t('projectEditDialog.actions.removeProjectIcon')}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Worktrees */}
            {isGitRepo ? (
              <div className="flex flex-col gap-2">
                <label className="typography-ui-label font-medium text-foreground">
                  {t('mobile.projectEdit.worktreesTitle')}
                </label>
                {worktrees.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">
                    {t('mobile.projectEdit.worktreesEmpty')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {worktrees.map((worktree) => (
                      <WorktreeRow
                        key={worktree.path}
                        worktree={worktree}
                        onDelete={() => setWorktreeToDelete(worktree)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {/* Isolated spaces: while the feature's switch is on; the phone is never VS Code. */}
            {isGitRepo && isolatedSpacesEnabled ? <MobileProjectSpaces projectPath={project.path} /> : null}
          </div>
        ) : null}
      </MobileFullscreenSurface>

      {project ? (
        <MobileDeleteWorktreeDialog
          open={Boolean(worktreeToDelete)}
          project={{ id: project.id, path: project.path }}
          worktree={worktreeToDelete}
          onClose={() => setWorktreeToDelete(null)}
        />
      ) : null}
    </>
  );
};
