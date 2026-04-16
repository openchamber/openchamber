import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { PROJECT_ICONS, PROJECT_COLORS, PROJECT_COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import {
  projectEditFailedToUploadIcon,
  projectEditIconUpdated,
  projectEditFailedToRemoveIcon,
  projectEditIconRemoved,
  projectEditFailedToDiscoverIcon,
  projectEditCustomIconAlreadySet,
  projectEditIconDiscovered,
  projectEditUploading,
  projectEditUploadIcon,
  projectEditDiscovering,
  projectEditDiscoverFavicon,
  projectEditRemoving,
  projectEditRemoveProjectIcon,
  projectEditUndoRemove,
  projectEditClear,
  projectEditCancel,
  projectEditSave,
  projectEditIconBackgroundAria,
  projectEditNamePlaceholder,
  projectEditIconBackgroundPlaceholder,
} from '@/lib/i18n/messages';
import { m } from '@/lib/i18n/messages';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  projectPath: string;
  initialIcon?: string | null;
  initialColor?: string | null;
  initialIconBackground?: string | null;
  onSave: (data: { label: string; icon: string | null; color: string | null; iconBackground: string | null }) => void;
}

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeIconBackground = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  projectName,
  projectPath,
  initialIcon = null,
  initialColor = null,
  initialIconBackground = null,
  onSave,
}) => {
  const uploadProjectIcon = useProjectsStore((state) => state.uploadProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const currentIconImage = useProjectsStore((state) => state.projects.find((project) => project.id === projectId)?.iconImage ?? null);
  const { currentTheme } = useThemeSystem();
  const [name, setName] = React.useState(projectName);
  const [icon, setIcon] = React.useState<string | null>(initialIcon);
  const [color, setColor] = React.useState<string | null>(initialColor);
  const [iconBackground, setIconBackground] = React.useState<string | null>(normalizeIconBackground(initialIconBackground));
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

  React.useEffect(() => {
    if (open) {
      setName(projectName);
      setIcon(initialIcon);
      setColor(initialColor);
      setIconBackground(normalizeIconBackground(initialIconBackground));
      setPendingRemoveImageIcon(false);
      clearPendingUploadIcon();
      setPreviewImageFailed(false);
    }
  }, [open, projectName, initialIcon, initialColor, initialIconBackground, clearPendingUploadIcon]);

  React.useEffect(() => {
    return () => {
      clearPendingUploadIcon();
    };
  }, [clearPendingUploadIcon]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    if (pendingUploadIconFile) {
      setIsUploadingIcon(true);
      const uploadResult = await uploadProjectIcon(projectId, pendingUploadIconFile);
      setIsUploadingIcon(false);
      if (!uploadResult.ok) {
        toast.error(uploadResult.error || projectEditFailedToUploadIcon());
        return;
      }
      toast.success(projectEditIconUpdated());
      clearPendingUploadIcon();
      setPendingRemoveImageIcon(false);
    }

    const willRemoveImageIcon = pendingRemoveImageIcon && hasStoredImageIcon;

    if (willRemoveImageIcon) {
      setIsRemovingCustomIcon(true);
      const result = await removeProjectIcon(projectId);
      setIsRemovingCustomIcon(false);
      if (!result.ok) {
        toast.error(result.error || projectEditFailedToRemoveIcon());
        return;
      }
      toast.success(projectEditIconRemoved());
      setPendingRemoveImageIcon(false);
      setIconBackground(null);
    }

    onSave({
      label: trimmed,
      icon,
      color,
      iconBackground: normalizeIconBackground(willRemoveImageIcon ? null : iconBackground),
    });
    onOpenChange(false);
  };

  const currentColorVar = color ? (PROJECT_COLOR_MAP[color] ?? null) : null;
  const hasStoredImageIcon = Boolean(currentIconImage);
  const hasPendingUploadImageIcon = Boolean(pendingUploadIconFile && pendingUploadIconPreviewUrl);
  const hasCustomIcon = currentIconImage?.source === 'custom';
  const effectiveHasImageIcon = (hasStoredImageIcon && !pendingRemoveImageIcon) || hasPendingUploadImageIcon;
  const hasRemovableImageIcon = effectiveHasImageIcon;
  const iconPreviewUrl = !previewImageFailed
    ? (hasPendingUploadImageIcon
      ? pendingUploadIconPreviewUrl
      : (hasStoredImageIcon && !pendingRemoveImageIcon
        ? getProjectIconImageUrl(
          { id: projectId, iconImage: currentIconImage ?? null },
          {
            themeVariant: currentTheme.metadata.variant,
            iconColor: currentTheme.colors.surface.foreground,
          },
        )
        : null))
    : null;

  React.useEffect(() => {
    setPreviewImageFailed(false);
  }, [projectId, currentIconImage?.updatedAt]);

  const handleUploadIcon = React.useCallback((file: File | null) => {
    if (!projectId || !file || isUploadingIcon) {
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
  }, [isUploadingIcon, projectId]);

  const handleRemoveImageIcon = React.useCallback(() => {
    if (!projectId || !hasRemovableImageIcon || isRemovingCustomIcon) {
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
    projectId,
  ]);

  const handleDiscoverIcon = React.useCallback(async () => {
    if (!projectId || isDiscoveringIcon) {
      return;
    }

    clearPendingUploadIcon();
    setPendingRemoveImageIcon(false);
    setPreviewImageFailed(false);

    setIsDiscoveringIcon(true);
    void discoverProjectIcon(projectId)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || projectEditFailedToDiscoverIcon());
          return;
        }
        if (result.skipped) {
          toast.success(projectEditCustomIconAlreadySet());
          return;
        }
        toast.success(projectEditIconDiscovered());
      })
      .finally(() => {
        setIsDiscoveringIcon(false);
      });
  }, [clearPendingUploadIcon, discoverProjectIcon, isDiscoveringIcon, projectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>{m.lyEditProject()}</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-5 py-1">
          {/* Name */}
          <div className="min-w-0 space-y-1.5">
            <label className="typography-ui-label font-medium text-foreground">
              {m.lyName()}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={projectEditNamePlaceholder()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
              autoFocus
            />
            <p className="typography-meta text-muted-foreground truncate" title={projectPath}>
              {projectPath}
            </p>
          </div>

          {/* Color */}
          <div className="min-w-0 space-y-2">
            <label className="typography-ui-label font-medium text-foreground">
              {m.lyColor()}
            </label>
            <div className="flex gap-2 flex-wrap">
              {/* No color option */}
              <button
                type="button"
                onClick={() => setColor(null)}
                className={cn(
                  'w-8 h-8 rounded-lg border-2 transition-all flex items-center justify-center',
                  color === null
                    ? 'border-foreground scale-110'
                    : 'border-border hover:border-border/80'
                )}
                title={projectEditIconBackgroundPlaceholder()}
              >
                <span className="w-4 h-0.5 bg-muted-foreground/40 rotate-45 rounded-full" />
              </button>
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setColor(c.key)}
                  className={cn(
                    'w-8 h-8 rounded-lg border-2 transition-all',
                    color === c.key
                      ? 'border-foreground scale-110'
                      : 'border-transparent hover:border-border'
                  )}
                  style={{ backgroundColor: c.cssVar }}
                  title={c.label}
                />
              ))}
            </div>
          </div>

          {/* Icon */}
          <div className="min-w-0 space-y-2">
            <label className="typography-ui-label font-medium text-foreground">
              {m.lyIcon()}
            </label>
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
            <div className="flex gap-2 flex-wrap">
              {/* No icon option */}
              <button
                type="button"
                onClick={() => setIcon(null)}
                className={cn(
                  'w-8 h-8 rounded-lg border-2 transition-all flex items-center justify-center',
                  icon === null
                    ? 'border-foreground scale-110 bg-[var(--surface-elevated)]'
                    : 'border-border hover:border-border/80'
                )}
                title={projectEditIconBackgroundPlaceholder()}
              >
                <span className="w-4 h-0.5 bg-muted-foreground/40 rotate-45 rounded-full" />
              </button>
              {PROJECT_ICONS.map((i) => {
                const IconComponent = i.Icon;
                return (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => setIcon(i.key)}
                    className={cn(
                      'w-8 h-8 rounded-lg border-2 transition-all flex items-center justify-center',
                      icon === i.key
                        ? 'border-foreground scale-110 bg-[var(--surface-elevated)]'
                        : 'border-border hover:border-border/80'
                    )}
                    title={i.label}
                  >
                    <IconComponent
                      className="w-4 h-4"
                      style={currentColorVar ? { color: currentColorVar } : undefined}
                    />
                  </button>
                );
              })}
            </div>
            {effectiveHasImageIcon && iconPreviewUrl && (
              <div className="flex items-center gap-2 pt-1">
                <span className="typography-meta text-muted-foreground">{m.lyPreview()}</span>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-1">
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
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {!hasCustomIcon && (
                <>
                  <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isUploadingIcon}>
                    {isUploadingIcon ? projectEditUploading() : projectEditUploadIcon()}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleDiscoverIcon()} disabled={isDiscoveringIcon}>
                    {isDiscoveringIcon ? projectEditDiscovering() : projectEditDiscoverFavicon()}
                  </Button>
                </>
              )}
              {hasRemovableImageIcon && (
                <Button size="sm" variant="outline" onClick={() => void handleRemoveImageIcon()} disabled={isRemovingCustomIcon}>
                  {isRemovingCustomIcon ? projectEditRemoving() : projectEditRemoveProjectIcon()}
                </Button>
              )}
              {pendingRemoveImageIcon && (
                <Button size="sm" variant="outline" onClick={() => setPendingRemoveImageIcon(false)} disabled={isRemovingCustomIcon}>
                  {projectEditUndoRemove()}
                </Button>
              )}
            </div>
          </div>

          {effectiveHasImageIcon && (
            <div className="min-w-0 space-y-2">
              <label className="typography-ui-label font-medium text-foreground">
                {m.lyIconBackground()}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  value={iconBackground ?? '#000000'}
                  onChange={(event) => setIconBackground(event.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-1"
                  aria-label={projectEditIconBackgroundAria()}
                />
                <Input
                  value={iconBackground ?? ''}
                  onChange={(event) => setIconBackground(event.target.value)}
                  placeholder={projectEditIconBackgroundPlaceholder()}
                  className="h-8 w-[8.5rem]"
                />
                <Button size="sm" variant="outline" onClick={() => setIconBackground(null)}>
                  {projectEditClear()}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {projectEditCancel()}
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || isUploadingIcon || isRemovingCustomIcon}>
            {projectEditSave()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
