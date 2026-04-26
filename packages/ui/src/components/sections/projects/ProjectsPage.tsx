import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { RiCloseLine } from '@remixicon/react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';

export const ProjectsPage: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const uploadProjectIcon = useProjectsStore((state) => state.uploadProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const { currentTheme } = useThemeSystem();

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [iconBackground, setIconBackground] = React.useState<string | null>(null);
  const [isUploadingIcon, setIsUploadingIcon] = React.useState(false);
  const [isRemovingCustomIcon, setIsRemovingCustomIcon] = React.useState(false);
  const [isDiscoveringIcon, setIsDiscoveringIcon] = React.useState(false);
  const [pendingRemoveImageIcon, setPendingRemoveImageIcon] = React.useState(false);
  const [pendingUploadIconFile, setPendingUploadIconFile] = React.useState<File | null>(null);
  const [pendingUploadIconPreviewUrl, setPendingUploadIconPreviewUrl] = React.useState<string | null>(null);
  const [previewImageFailed, setPreviewImageFailed] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const clearPendingUploadIcon = React.useCallback(() => {
    setPendingUploadIconFile(null);
    setPendingUploadIconPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
  }, []);

  const selectedProjectRef = React.useMemo(() => {
    if (!selectedProject) {
      return null;
    }
    return { id: selectedProject.id, path: selectedProject.path };
  }, [selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      setName('');
      setIcon(null);
      setColor(null);
      setIconBackground(null);
      return;
    }
    setName(selectedProject.label ?? '');
    setIcon(selectedProject.icon ?? null);
    setColor(selectedProject.color ?? null);
    setIconBackground(selectedProject.iconBackground ?? null);
    setPendingRemoveImageIcon(false);
    clearPendingUploadIcon();
    setPreviewImageFailed(false);
  }, [selectedProject, clearPendingUploadIcon]);

  React.useEffect(() => {
    return () => {
      clearPendingUploadIcon();
    };
  }, [clearPendingUploadIcon]);

  const hasChanges = Boolean(selectedProject) && (
    name.trim() !== (selectedProject?.label ?? '').trim()
    || icon !== (selectedProject?.icon ?? null)
    || color !== (selectedProject?.color ?? null)
    || iconBackground !== (selectedProject?.iconBackground ?? null)
    || pendingRemoveImageIcon
    || Boolean(pendingUploadIconFile)
  );

  const handleSave = React.useCallback(async () => {
    if (!selectedProject) return;

    if (pendingUploadIconFile) {
      setIsUploadingIcon(true);
      const uploadResult = await uploadProjectIcon(selectedProject.id, pendingUploadIconFile);
      setIsUploadingIcon(false);
      if (!uploadResult.ok) {
        toast.error(uploadResult.error || t('settings.projects.page.toast.uploadIconFailed'));
        return;
      }
      toast.success(t('settings.projects.page.toast.iconUpdated'));
      clearPendingUploadIcon();
      setPendingRemoveImageIcon(false);
    }

    const willRemoveImageIcon = pendingRemoveImageIcon && Boolean(selectedProject.iconImage);

    if (willRemoveImageIcon) {
      setIsRemovingCustomIcon(true);
      const removeResult = await removeProjectIcon(selectedProject.id);
      setIsRemovingCustomIcon(false);
      if (!removeResult.ok) {
        toast.error(removeResult.error || t('settings.projects.page.toast.removeIconFailed'));
        return;
      }
      toast.success(t('settings.projects.page.toast.iconRemoved'));
      setPendingRemoveImageIcon(false);
      setIconBackground(null);
    }

    updateProjectMeta(selectedProject.id, {
      label: name.trim(),
      icon,
      color,
      iconBackground: willRemoveImageIcon ? null : iconBackground,
    });
  }, [
    color,
    icon,
    iconBackground,
    name,
    pendingUploadIconFile,
    pendingRemoveImageIcon,
    clearPendingUploadIcon,
    uploadProjectIcon,
    removeProjectIcon,
    selectedProject,
    updateProjectMeta,
  ]);

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;
  const hasStoredImageIcon = Boolean(selectedProject?.iconImage);
  const hasPendingUploadImageIcon = Boolean(pendingUploadIconFile && pendingUploadIconPreviewUrl);
  const hasCustomIcon = selectedProject?.iconImage?.source === 'custom';
  const effectiveHasImageIcon = (hasStoredImageIcon && !pendingRemoveImageIcon) || hasPendingUploadImageIcon;
  const hasRemovableImageIcon = effectiveHasImageIcon;
  const iconPreviewUrl = !previewImageFailed
    ? (hasPendingUploadImageIcon
      ? pendingUploadIconPreviewUrl
      : (selectedProject && hasStoredImageIcon && !pendingRemoveImageIcon
        ? getProjectIconImageUrl(selectedProject, {
          themeVariant: currentTheme.metadata.variant,
          iconColor: currentTheme.colors.surface.foreground,
        })
        : null))
    : null;

  const handleUploadIcon = React.useCallback((file: File | null) => {
    if (!selectedProject || !file || isUploadingIcon) {
      return;
    }

    setPendingRemoveImageIcon(false);
    setPreviewImageFailed(false);
    setPendingUploadIconFile(file);
    setPendingUploadIconPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return URL.createObjectURL(file);
    });
  }, [isUploadingIcon, selectedProject]);

  const handleRemoveImageIcon = React.useCallback(() => {
    if (!selectedProject || !hasRemovableImageIcon || isRemovingCustomIcon) {
      return;
    }

    if (hasPendingUploadImageIcon) {
      clearPendingUploadIcon();
    }
    if (hasStoredImageIcon) {
      setPendingRemoveImageIcon(true);
    } else {
      setPendingRemoveImageIcon(false);
    }
    setPreviewImageFailed(false);
  }, [
    clearPendingUploadIcon,
    hasPendingUploadImageIcon,
    hasRemovableImageIcon,
    hasStoredImageIcon,
    isRemovingCustomIcon,
    selectedProject,
  ]);

  const handleDiscoverIcon = React.useCallback(async () => {
    if (!selectedProject || isDiscoveringIcon) {
      return;
    }

    clearPendingUploadIcon();
    setPendingRemoveImageIcon(false);
    setPreviewImageFailed(false);

    setIsDiscoveringIcon(true);
    void discoverProjectIcon(selectedProject.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || t('settings.projects.page.toast.discoverIconFailed'));
          return;
        }
        if (result.skipped) {
          toast.success(t('settings.projects.page.toast.customIconAlreadySet'));
          return;
        }
        toast.success(t('settings.projects.page.toast.iconDiscovered'));
      })
      .finally(() => {
        setIsDiscoveringIcon(false);
      });
  }, [clearPendingUploadIcon, discoverProjectIcon, isDiscoveringIcon, selectedProject, t]);

  if (!selectedProject) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">{t('settings.projects.page.empty.noProjects')}</p>
        </div>
      </ScrollableOverlay>
    );
  }
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        
        {/* Top Header & Actions */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProject.label ?? t('settings.projects.page.title.default')}
            </h2>
            <p className="typography-meta text-muted-foreground truncate" title={selectedProject.path}>
              {selectedProject.path}
            </p>
          </div>
        </div>

        {/* Identity Controls */}
        <div className="mb-8">
          <section className="px-2 pb-2 pt-0 space-y-0.5">
            
            {/* Name */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.projectName')}</span>
              </div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <Input 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  placeholder={t('settings.projects.page.field.projectNamePlaceholder')} 
                  className="h-7 min-w-0 w-full sm:max-w-[19rem]" 
                />
              </div>
            </div>

            {/* Color */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.accentColor')}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  className={cn(
                    'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                    color === null
                      ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                      : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title={t('settings.projects.page.field.none')}
                >
                  <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                </button>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    className={cn(
                      'h-7 w-7 rounded-md border transition-colors',
                      color === c.key
                        ? 'border-2 border-foreground ring-1 ring-[var(--primary-base)]/40'
                        : 'border-transparent hover:border-border/70'
                    )}
                    style={{ backgroundColor: c.cssVar }}
                    title={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Icon */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.projectIcon')}</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void handleUploadIcon(file);
                  event.currentTarget.value = '';
                }}
              />
              <div className="mt-1.5 flex max-w-[22rem] flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className={cn(
                    'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                    icon === null
                      ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                      : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title={t('settings.projects.page.field.none')}
                >
                  <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                </button>
                {PROJECT_ICONS.map((i) => {
                  const IconComponent = i.Icon;
                  return (
                    <button
                      key={i.key}
                      type="button"
                      onClick={() => setIcon(i.key)}
                      className={cn(
                        'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                        icon === i.key
                          ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                          : 'border-transparent hover:border-border hover:bg-[var(--surface-muted)]'
                      )}
                      title={i.label}
                    >
                      <IconComponent className="w-4 h-4" style={currentColorVar && icon === i.key ? { color: currentColorVar } : undefined} />
                    </button>
                  );
                })}
              </div>
              {effectiveHasImageIcon && iconPreviewUrl && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="typography-meta text-muted-foreground">{t('settings.projects.page.field.preview')}</span>
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-[var(--surface-elevated)] p-1">
                    <span
                      className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
                      style={iconBackground ? { backgroundColor: iconBackground } : undefined}
                    >
                      <img
                        src={iconPreviewUrl}
                        alt=""
                        className="h-full w-full object-contain"
                        draggable={false}
                        onError={() => setPreviewImageFailed(true)}
                      />
                    </span>
                  </span>
                </div>
              )}
              {effectiveHasImageIcon && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={iconBackground ?? '#000000'}
                    onChange={(event) => setIconBackground(event.target.value)}
                    className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-1"
                    aria-label={t('settings.projects.page.field.projectIconBackgroundAria')}
                  />
                  <Input
                    value={iconBackground ?? ''}
                    onChange={(event) => setIconBackground(event.target.value)}
                    placeholder="#000000"
                    className="h-7 w-[8rem]"
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setIconBackground(null)}
                    className="h-7 w-7 p-0"
                    aria-label={t('settings.projects.page.field.clearIconBackgroundAria')}
                    title={t('settings.projects.page.field.clearBackground')}
                    disabled={!iconBackground}
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!hasCustomIcon && (
                  <>
                    <Button
                      size="xs"
                      className="h-6 !font-normal"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploadingIcon}
                    >
                      {isUploadingIcon ? t('settings.projects.page.actions.uploading') : t('settings.projects.page.actions.uploadIcon')}
                    </Button>
                    <Button
                      size="xs"
                      className="h-6 !font-normal"
                      variant="outline"
                      onClick={() => void handleDiscoverIcon()}
                      disabled={isDiscoveringIcon}
                    >
                      {isDiscoveringIcon ? t('settings.projects.page.actions.discovering') : t('settings.projects.page.actions.discoverFavicon')}
                    </Button>
                  </>
                )}
                {hasRemovableImageIcon && (
                  <Button
                    size="xs"
                    className="!font-normal"
                    variant="outline"
                    onClick={() => void handleRemoveImageIcon()}
                    disabled={isRemovingCustomIcon}
                  >
                    {isRemovingCustomIcon ? t('settings.projects.page.actions.removing') : t('settings.projects.page.actions.removeProjectIcon')}
                  </Button>
                )}
                {pendingRemoveImageIcon && (
                  <Button
                    size="xs"
                    className="!font-normal"
                    variant="outline"
                    onClick={() => setPendingRemoveImageIcon(false)}
                    disabled={isRemovingCustomIcon}
                  >
                    {t('settings.projects.page.actions.undoRemove')}
                  </Button>
                )}
              </div>
            </div>

          </section>
          
          <div className="mt-0.5 px-2 py-1">
            <Button
              onClick={handleSave}
              disabled={!hasChanges || name.trim().length === 0 || isUploadingIcon || isRemovingCustomIcon}
              size="xs"
              className="!font-normal"
            >
              {t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </div>

        {/* Worktree Group */}
        <div className="mb-8">
          <section className="px-2 pb-2 pt-0">
            {selectedProjectRef && <ProjectActionsSection projectRef={selectedProjectRef} />}
          </section>
        </div>

        {/* Worktree Group */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.projects.page.section.worktree')}
            </h3>
          </div>
          <section className="px-2 pb-2 pt-0">
            {selectedProjectRef && <WorktreeSectionContent projectRef={selectedProjectRef} />}
          </section>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
