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
  const [name, setName] = React.useState(projectName);
  const [icon, setIcon] = React.useState<string | null>(initialIcon);
  const [color, setColor] = React.useState<string | null>(initialColor);
  const [iconBackground, setIconBackground] = React.useState<string | null>(normalizeIconBackground(initialIconBackground));
  const [isUploadingIcon, setIsUploadingIcon] = React.useState(false);
  const [isRemovingCustomIcon, setIsRemovingCustomIcon] = React.useState(false);
  const [isDiscoveringIcon, setIsDiscoveringIcon] = React.useState(false);
  const [previewImageFailed, setPreviewImageFailed] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(projectName);
      setIcon(initialIcon);
      setColor(initialColor);
      setIconBackground(normalizeIconBackground(initialIconBackground));
    }
  }, [open, projectName, initialIcon, initialColor, initialIconBackground]);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({ label: trimmed, icon, color, iconBackground: normalizeIconBackground(iconBackground) });
    onOpenChange(false);
  };

  const currentColorVar = color ? (PROJECT_COLOR_MAP[color] ?? null) : null;
  const hasImageIcon = Boolean(currentIconImage);
  const hasCustomIcon = currentIconImage?.source === 'custom';
  const iconPreviewUrl = hasImageIcon && !previewImageFailed
    ? getProjectIconImageUrl({ id: projectId, iconImage: currentIconImage ?? null })
    : null;

  React.useEffect(() => {
    setPreviewImageFailed(false);
  }, [projectId, currentIconImage?.updatedAt]);

  const handleUploadIcon = React.useCallback(async (file: File | null) => {
    if (!projectId || !file || isUploadingIcon) {
      return;
    }

    setIsUploadingIcon(true);
    void uploadProjectIcon(projectId, file)
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
  }, [isUploadingIcon, projectId, uploadProjectIcon]);

  const handleRemoveCustomIcon = React.useCallback(async () => {
    if (!projectId || !hasCustomIcon || isRemovingCustomIcon) {
      return;
    }

    setIsRemovingCustomIcon(true);
    void removeProjectIcon(projectId)
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
  }, [hasCustomIcon, isRemovingCustomIcon, projectId, removeProjectIcon]);

  const handleDiscoverIcon = React.useCallback(async () => {
    if (!projectId || isDiscoveringIcon) {
      return;
    }

    setIsDiscoveringIcon(true);
    void discoverProjectIcon(projectId)
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
  }, [discoverProjectIcon, isDiscoveringIcon, projectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-5 py-1">
          {/* Name */}
          <div className="min-w-0 space-y-1.5">
            <label className="typography-ui-label font-medium text-foreground">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
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
              Color
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
                title="None"
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
              Icon
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
                title="None"
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
            {hasImageIcon && iconPreviewUrl && (
              <div className="flex items-center gap-2 pt-1">
                <span className="typography-meta text-muted-foreground">Preview</span>
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
                    {isUploadingIcon ? 'Uploading...' : 'Upload Icon'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleDiscoverIcon()} disabled={isDiscoveringIcon}>
                    {isDiscoveringIcon ? 'Discovering...' : 'Discover Favicon'}
                  </Button>
                </>
              )}
              {hasCustomIcon && (
                <Button size="sm" variant="outline" onClick={() => void handleRemoveCustomIcon()} disabled={isRemovingCustomIcon}>
                  {isRemovingCustomIcon ? 'Removing...' : 'Remove Custom Icon'}
                </Button>
              )}
            </div>
          </div>

          {hasImageIcon && (
            <div className="min-w-0 space-y-2">
              <label className="typography-ui-label font-medium text-foreground">
                Icon Background
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  value={iconBackground ?? '#000000'}
                  onChange={(event) => setIconBackground(event.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-1"
                  aria-label="Project icon background color"
                />
                <Input
                  value={iconBackground ?? ''}
                  onChange={(event) => setIconBackground(event.target.value)}
                  placeholder="#000000"
                  className="h-8 w-[8.5rem]"
                />
                <Button size="sm" variant="outline" onClick={() => setIconBackground(null)}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
