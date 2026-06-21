import React from 'react';
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
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { invokeDesktop, requestFileAccess } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { PetSprite } from '@/components/pet/PetSprite';

// Codex/petdex spritesheet image types accepted by the pet renderer.
const IMAGE_EXTENSIONS = ['webp', 'png', 'apng', 'gif', 'jpg', 'jpeg'];
// Sprite scale that fits a 192x208 cell inside the ~176px preview square.
const PREVIEW_SCALE = 0.78;

type SavedPet = { slug: string; displayName: string; description: string };

export type PetEditTarget = { slug: string; displayName: string; description: string };

const basename = (filePath: string): string => filePath.replace(/\\/g, '/').split('/').pop() ?? '';

// Shared create/edit form. In edit mode it prefills name/description, loads the
// current spritesheet for the live preview, and treats a new image as optional
// (an unchanged pet keeps its existing sheet). The pet slug is the stable id, so
// editing never moves the folder.
export const CreatePetDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (slug: string) => void;
  editTarget?: PetEditTarget | null;
}> = ({ open, onOpenChange, onSaved, editTarget = null }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const isEdit = Boolean(editTarget);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [imagePath, setImagePath] = React.useState('');
  // Spritesheet inlined as a data URL by the shell so we can animate a live
  // preview before the pet is written to disk.
  const [previewUrl, setPreviewUrl] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  // Reset (create) or prefill from the edit target each time the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setSaving(false);
    setImagePath('');
    if (!editTarget) {
      setName('');
      setDescription('');
      setPreviewUrl('');
      return;
    }
    setName(editTarget.displayName);
    setDescription(editTarget.description);
    setPreviewUrl('');
    // Load the current spritesheet so the preview animates the real pet.
    let active = true;
    void (async () => {
      try {
        const result = await invokeDesktop<{ spritesheetDataUrl?: string } | null>('desktop_pet_get', {
          slug: editTarget.slug,
        });
        if (active && result?.spritesheetDataUrl) setPreviewUrl(result.spritesheetDataUrl);
      } catch {
        // Preview stays empty; editing name/description still works.
      }
    })();
    return () => {
      active = false;
    };
  }, [open, editTarget]);

  const chooseImage = async () => {
    const picked = await requestFileAccess({ filters: [{ name: 'Spritesheet', extensions: IMAGE_EXTENSIONS }] });
    if (!picked.success || !picked.path) return;
    setImagePath(picked.path);
    try {
      const result = await invokeDesktop<{ dataUrl?: string } | null>('desktop_pet_preview_image', {
        imagePath: picked.path,
      });
      if (result?.dataUrl) {
        setPreviewUrl(result.dataUrl);
      } else {
        setPreviewUrl('');
        toast.error(t('settings.openchamber.pet.create.previewFailed'));
      }
    } catch {
      setPreviewUrl('');
      toast.error(t('settings.openchamber.pet.create.previewFailed'));
    }
  };

  // Create requires an image; edit keeps the existing sheet unless one is picked.
  const canSubmit = name.trim().length > 0 && !saving && (isEdit || imagePath.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      if (editTarget) {
        const updated = await invokeDesktop<SavedPet>('desktop_pet_edit', {
          slug: editTarget.slug,
          displayName: name.trim(),
          description: description.trim(),
          imagePath,
        });
        if (updated?.slug) onSaved(updated.slug);
        toast.success(t('settings.openchamber.pet.editSuccess'));
      } else {
        const created = await invokeDesktop<SavedPet>('desktop_pet_create', {
          displayName: name.trim(),
          description: description.trim(),
          imagePath,
        });
        if (created?.slug) onSaved(created.slug);
        toast.success(t('settings.openchamber.pet.createSuccess'));
      }
      onOpenChange(false);
    } catch {
      toast.error(t(isEdit ? 'settings.openchamber.pet.editFailed' : 'settings.openchamber.pet.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('settings.openchamber.pet.edit.title') : t('settings.openchamber.pet.create.title')}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t('settings.openchamber.pet.edit.description') : t('settings.openchamber.pet.create.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2 sm:flex-row sm:items-start">
          {/* Animated square preview — empty until a spritesheet is chosen/loaded.
              The whole square is the picker so the empty state is also the action. */}
          <button
            type="button"
            onClick={() => void chooseImage()}
            aria-label={t('settings.openchamber.pet.create.chooseImage')}
            className={cn(
              'relative flex h-44 w-44 shrink-0 items-center justify-center overflow-hidden rounded-xl border transition-colors',
              previewUrl
                ? 'border-[var(--interactive-border)]'
                : 'border-dashed border-[var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
            )}
            style={{ backgroundColor: currentTheme.colors.surface.muted }}
          >
            {previewUrl ? (
              <PetSprite spritesheetDataUrl={previewUrl} state="idle" scale={PREVIEW_SCALE} />
            ) : (
              <span className="flex flex-col items-center gap-1.5 px-3 text-center">
                <Icon name="file-image" className="h-6 w-6 text-muted-foreground" />
                <span className="typography-meta text-muted-foreground/80">
                  {t('settings.openchamber.pet.create.previewEmpty')}
                </span>
              </span>
            )}
          </button>

          {/* Pet settings beside the preview. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.openchamber.pet.create.nameLabel')}
              </label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('settings.openchamber.pet.create.namePlaceholder')}
                className="h-8"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.openchamber.pet.create.descriptionLabel')}
              </label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('settings.openchamber.pet.create.descriptionPlaceholder')}
                className="h-8"
              />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void chooseImage()}>
                <Icon name="file-image" className="mr-1 h-3.5 w-3.5" />
                {(imagePath || isEdit)
                  ? t('settings.openchamber.pet.create.changeImage')
                  : t('settings.openchamber.pet.create.chooseImage')}
              </Button>
              {imagePath && (
                <span className="typography-meta text-muted-foreground min-w-0 flex-1 truncate">{basename(imagePath)}</span>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('settings.openchamber.pet.create.cancel')}
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {saving
              ? t(isEdit ? 'settings.openchamber.pet.edit.saving' : 'settings.openchamber.pet.create.creating')
              : t(isEdit ? 'settings.openchamber.pet.edit.submit' : 'settings.openchamber.pet.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
