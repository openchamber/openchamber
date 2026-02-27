import React from 'react';
import { Input } from '@/components/ui/input';
import { ButtonSmall } from '@/components/ui/button-small';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { RiCloseLine } from '@remixicon/react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';

export const ProjectsPage: React.FC = () => {
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const uploadProjectIcon = useProjectsStore((state) => state.uploadProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

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
  const [previewImageFailed, setPreviewImageFailed] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

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
    setPreviewImageFailed(false);
  }, [selectedProject]);

  const hasChanges = Boolean(selectedProject) && (
    name.trim() !== (selectedProject?.label ?? '').trim()
    || icon !== (selectedProject?.icon ?? null)
    || color !== (selectedProject?.color ?? null)
    || iconBackground !== (selectedProject?.iconBackground ?? null)
  );

  const handleSave = React.useCallback(() => {
    if (!selectedProject) return;
    updateProjectMeta(selectedProject.id, { label: name.trim(), icon, color, iconBackground });
  }, [color, icon, iconBackground, name, selectedProject, updateProjectMeta]);

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;
  const hasImageIcon = Boolean(selectedProject?.iconImage);
  const hasCustomIcon = selectedProject?.iconImage?.source === 'custom';
  const iconPreviewUrl = selectedProject && hasImageIcon && !previewImageFailed
    ? getProjectIconImageUrl(selectedProject)
    : null;

  const handleUploadIcon = React.useCallback(async (file: File | null) => {
    if (!selectedProject || !file || isUploadingIcon) {
      return;
    }

    setIsUploadingIcon(true);
    void uploadProjectIcon(selectedProject.id, file)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || 'Failed to upload project icon');
          return;
        }
        toast.success('Project icon updated');
      })
      .finally(() => {
        setIsUploadingIcon(false);
      });
  }, [isUploadingIcon, selectedProject, uploadProjectIcon]);

  const handleRemoveCustomIcon = React.useCallback(async () => {
    if (!selectedProject || !hasCustomIcon || isRemovingCustomIcon) {
      return;
    }

    setIsRemovingCustomIcon(true);
    void removeProjectIcon(selectedProject.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || 'Failed to remove project icon');
          return;
        }
        toast.success('Custom project icon removed');
      })
      .finally(() => {
        setIsRemovingCustomIcon(false);
      });
  }, [hasCustomIcon, isRemovingCustomIcon, removeProjectIcon, selectedProject]);

  const handleDiscoverIcon = React.useCallback(async () => {
    if (!selectedProject || isDiscoveringIcon) {
      return;
    }

    setIsDiscoveringIcon(true);
    void discoverProjectIcon(selectedProject.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || 'Failed to discover project icon');
          return;
        }
        if (result.skipped) {
          toast.success('Custom icon already set for this project');
          return;
        }
        toast.success('Project icon discovered');
      })
      .finally(() => {
        setIsDiscoveringIcon(false);
      });
  }, [discoverProjectIcon, isDiscoveringIcon, selectedProject]);

  if (!selectedProject) {
    return (
      <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">No projects available.</p>
        </div>
      </ScrollableOverlay>
    );
  }
  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        
        {/* Top Header & Actions */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProject.label ?? 'Project Settings'}
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
                <span className="typography-ui-label text-foreground">Project Name</span>
              </div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <Input 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  placeholder="Project name" 
                  className="h-7 min-w-0 w-full sm:max-w-[19rem]" 
                />
              </div>
            </div>

            {/* Color */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">Accent Color</span>
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
                  title="None"
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
                <span className="typography-ui-label text-foreground">Project Icon</span>
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
                  title="None"
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
              {hasImageIcon && iconPreviewUrl && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="typography-meta text-muted-foreground">Preview</span>
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
              {hasImageIcon && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={iconBackground ?? '#000000'}
                    onChange={(event) => setIconBackground(event.target.value)}
                    className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-1"
                    aria-label="Project icon background color"
                  />
                  <Input
                    value={iconBackground ?? ''}
                    onChange={(event) => setIconBackground(event.target.value)}
                    placeholder="#000000"
                    className="h-7 w-[8rem]"
                  />
                  <ButtonSmall
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setIconBackground(null)}
                    className="h-7 w-7 p-0"
                    aria-label="Clear icon background"
                    title="Clear background"
                    disabled={!iconBackground}
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </ButtonSmall>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!hasCustomIcon && (
                  <>
                    <ButtonSmall
                      size="xs"
                      className="h-6 !font-normal"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploadingIcon}
                    >
                      {isUploadingIcon ? 'Uploading...' : 'Upload Icon'}
                    </ButtonSmall>
                    <ButtonSmall
                      size="xs"
                      className="h-6 !font-normal"
                      variant="outline"
                      onClick={() => void handleDiscoverIcon()}
                      disabled={isDiscoveringIcon}
                    >
                      {isDiscoveringIcon ? 'Discovering...' : 'Discover Favicon'}
                    </ButtonSmall>
                  </>
                )}
                {hasCustomIcon && (
                  <ButtonSmall
                    size="xs"
                    className="!font-normal"
                    variant="outline"
                    onClick={() => void handleRemoveCustomIcon()}
                    disabled={isRemovingCustomIcon}
                  >
                    {isRemovingCustomIcon ? 'Removing...' : 'Remove Custom Icon'}
                  </ButtonSmall>
                )}
              </div>
            </div>

          </section>
          
          <div className="mt-0.5 px-2 py-1">
            <ButtonSmall
              onClick={handleSave}
              disabled={!hasChanges || name.trim().length === 0}
              size="xs"
              className="!font-normal"
            >
              Save Changes
            </ButtonSmall>
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
              Worktree
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
