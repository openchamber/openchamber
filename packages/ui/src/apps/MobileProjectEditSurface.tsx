import React from 'react';
import { RiCheckLine, RiDeleteBinLine, RiDragMove2Line, RiFolder6Line } from '@remixicon/react';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLORS, PROJECT_COLOR_MAP, PROJECT_ICONS, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import type { WorktreeMetadata } from '@/types/worktree';

import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { MobileSurfaceShell } from './MobileSurfaceShell';

type MobileEditableProject = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
  isGitRepo: boolean;
  worktrees: WorktreeMetadata[];
};

type MobileProjectEditSurfaceProps = {
  open: boolean;
  project: MobileEditableProject | null;
  onClose: () => void;
  /** Called after a worktree is deleted so the parent can re-list worktrees. */
  onWorktreesChanged?: () => void;
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

const SortableWorktreeRow: React.FC<{
  worktree: WorktreeMetadata;
  onDelete: () => void;
}> = ({ worktree, onDelete }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: worktree.path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };
  const label = worktree.branch || worktree.label || worktree.path;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 rounded-2xl border border-border/40 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <button
        type="button"
        className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.projectEdit.dragWorktreeAria', { label })}
        {...attributes}
        {...listeners}
      >
        <RiDragMove2Line className="size-4" />
      </button>
      <Icon name="node-tree" className="size-4 shrink-0 text-muted-foreground" />
      <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{label}</span>
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
        aria-label={t('mobile.projectEdit.deleteWorktreeAria', { label })}
        onClick={onDelete}
        style={{ touchAction: 'manipulation' }}
      >
        <RiDeleteBinLine className="size-4" />
      </button>
    </div>
  );
};

export const MobileProjectEditSurface: React.FC<MobileProjectEditSurfaceProps> = ({
  open,
  project,
  onClose,
  onWorktreesChanged,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  const setWorktreeOrder = useWorktreeOrderStore((state) => state.setWorktreeOrder);
  // Read the live icon image from the store so discover/remove reflect instantly.
  const currentIconImage = useProjectsStore((state) =>
    project ? state.projects.find((entry) => entry.id === project.id)?.iconImage ?? null : null,
  );

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [orderedWorktrees, setOrderedWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<WorktreeMetadata | null>(null);

  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
    setIcon(project.icon ?? null);
    setColor(project.color ?? null);
    setOrderedWorktrees(project.worktrees);
    // Re-seed only when the edited project or sheet visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // Keep the worktree list in sync as the underlying project data updates
  // (e.g. after a deletion), without clobbering an in-progress drag order.
  React.useEffect(() => {
    if (!open || !project) return;
    setOrderedWorktrees((previous) => {
      const incomingPaths = project.worktrees.map((worktree) => worktree.path);
      const previousPaths = previous.map((worktree) => worktree.path);
      const sameSet =
        incomingPaths.length === previousPaths.length &&
        incomingPaths.every((path) => previousPaths.includes(path));
      return sameSet ? previous : project.worktrees;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.worktrees]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleSave = () => {
    if (!project) return;
    const trimmed = name.trim();
    updateProjectMeta(project.id, {
      label: trimmed || project.label,
      icon,
      color,
    });
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

  const handleWorktreeDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !project) return;
    const fromIndex = orderedWorktrees.findIndex((worktree) => worktree.path === active.id);
    const toIndex = orderedWorktrees.findIndex((worktree) => worktree.path === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...orderedWorktrees];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setOrderedWorktrees(next);
    setWorktreeOrder(
      project.id,
      next.map((worktree) => normalizePath(worktree.path)),
    );
  };

  const currentColorVar = color ? PROJECT_COLOR_MAP[color] ?? null : null;
  const previewIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const hasImageIcon = Boolean(currentIconImage);

  return (
    <>
      <MobileSurfaceShell
        open={open}
        onClose={onClose}
        onBack={onClose}
        title={t('projectEditDialog.title')}
        ariaLabel={t('projectEditDialog.title')}
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
                    color === null ? 'border-foreground' : 'border-border hover:border-border/80',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
                </button>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    aria-label={c.label}
                    title={c.label}
                    className={cn(
                      'size-9 rounded-xl border-2 transition-all',
                      color === c.key ? 'border-foreground' : 'border-transparent hover:border-border',
                    )}
                    style={{ backgroundColor: c.cssVar, touchAction: 'manipulation' }}
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
                    icon === null ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border hover:border-border/80',
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
                      icon === i.key ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border hover:border-border/80',
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
            {project.isGitRepo ? (
              <div className="flex flex-col gap-2">
                <label className="typography-ui-label font-medium text-foreground">
                  {t('mobile.projectEdit.worktreesTitle')}
                </label>
                {orderedWorktrees.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">
                    {t('mobile.projectEdit.worktreesEmpty')}
                  </p>
                ) : (
                  <>
                    <p className="typography-meta text-muted-foreground">
                      {t('mobile.projectEdit.reorderHint')}
                    </p>
                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleWorktreeDragEnd}>
                      <SortableContext
                        items={orderedWorktrees.map((worktree) => worktree.path)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col gap-1.5">
                          {orderedWorktrees.map((worktree) => (
                            <SortableWorktreeRow
                              key={worktree.path}
                              worktree={worktree}
                              onDelete={() => setWorktreeToDelete(worktree)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </MobileSurfaceShell>

      {project ? (
        <MobileDeleteWorktreeDialog
          open={Boolean(worktreeToDelete)}
          project={{ id: project.id, path: project.path }}
          worktree={worktreeToDelete}
          onClose={() => setWorktreeToDelete(null)}
          onDeleted={() => {
            setOrderedWorktrees((previous) =>
              previous.filter((worktree) => worktree.path !== worktreeToDelete?.path),
            );
            onWorktreesChanged?.();
          }}
        />
      ) : null}
    </>
  );
};
