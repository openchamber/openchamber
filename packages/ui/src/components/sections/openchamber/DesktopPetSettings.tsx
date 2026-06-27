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
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { invokeDesktop } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useDesktopPetStore } from '@/stores/useDesktopPetStore';
import { PetSprite } from '@/components/pet/PetSprite';
import { CreatePetDialog } from './CreatePetDialog';

// Desktop-only Settings → Pet page for the floating companion. Drives
// useDesktopPetStore (which owns the IPC + reconciliation). The layout mirrors
// Codex's pets surface: a single card with a header toolbar (create/refresh/wake),
// a vertical list of installed pets (animated thumbnail + name/description, with
// per-row edit/delete + select), and a footer exposing the custom-pets folder.

type PetListEntry = { slug: string; displayName: string; description: string };

// Sprite scale that fits a 192x208 cell inside the ~64px row thumbnail.
const THUMB_SCALE = 0.3;

export const DesktopPetSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useDesktopPetStore((store) => store.enabled);
  const selectedSlug = useDesktopPetStore((store) => store.selectedSlug);
  const setEnabled = useDesktopPetStore((store) => store.setEnabled);
  const selectPet = useDesktopPetStore((store) => store.selectPet);
  const hydrate = useDesktopPetStore((store) => store.hydrate);

  const [pets, setPets] = React.useState<PetListEntry[]>([]);
  const [thumbs, setThumbs] = React.useState<Record<string, string>>({});
  const [petsDir, setPetsDir] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<PetListEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<PetListEntry | null>(null);
  // Track which spritesheets we've already requested so a re-render (or the
  // safety re-fetch) never re-pulls the same data URL.
  const requestedThumbsRef = React.useRef<Set<string>>(new Set());

  const refreshPets = React.useCallback(async () => {
    try {
      const result = await invokeDesktop<{ pets?: PetListEntry[]; dir?: string }>('desktop_pet_list');
      setPets(Array.isArray(result?.pets) ? result.pets : []);
      if (typeof result?.dir === 'string') setPetsDir(result.dir);
    } catch {
      setPets([]);
    }
  }, []);

  React.useEffect(() => {
    void hydrate();
    void refreshPets();
  }, [hydrate, refreshPets]);

  // Lazily inline each pet's spritesheet (settings page, not a hot path) so the
  // list can show an animated thumbnail. Fetched once per slug.
  React.useEffect(() => {
    let active = true;
    (async () => {
      for (const pet of pets) {
        if (requestedThumbsRef.current.has(pet.slug)) continue;
        requestedThumbsRef.current.add(pet.slug);
        try {
          const result = await invokeDesktop<{ spritesheetDataUrl?: string } | null>('desktop_pet_get', {
            slug: pet.slug,
          });
          if (active && result?.spritesheetDataUrl) {
            const dataUrl = result.spritesheetDataUrl;
            setThumbs((prev) => ({ ...prev, [pet.slug]: dataUrl }));
          }
        } catch {
          // Leave the thumbnail empty; the name still identifies the pet.
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [pets]);

  // Drop a cached thumbnail so it re-fetches (used after an edit may have
  // swapped the spritesheet, or after delete).
  const invalidateThumb = React.useCallback((slug: string) => {
    requestedThumbsRef.current.delete(slug);
    setThumbs((prev) => {
      if (!(slug in prev)) return prev;
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  // "Wake"/"Sleep" is the enable toggle in disguise: waking opens the floating
  // pet window, sleeping closes it. Waking with no selection picks the first pet
  // so we never float an empty window.
  const handleWakeToggle = React.useCallback(() => {
    if (enabled) {
      void setEnabled(false);
      return;
    }
    if (!selectedSlug && pets.length > 0) {
      void selectPet(pets[0].slug);
    }
    void setEnabled(true);
  }, [enabled, pets, selectedSlug, selectPet, setEnabled]);

  const handleSelect = React.useCallback((slug: string) => {
    if (slug === selectedSlug) return;
    void selectPet(slug);
  }, [selectedSlug, selectPet]);

  const openCreate = React.useCallback(() => {
    setEditTarget(null);
    setDialogOpen(true);
  }, []);

  const openEdit = React.useCallback((pet: PetListEntry) => {
    setEditTarget(pet);
    setDialogOpen(true);
  }, []);

  const handleOpenFolder = React.useCallback(async () => {
    if (!petsDir) return;
    try {
      await invokeDesktop('desktop_open_path', { path: petsDir });
    } catch {
      toast.error(t('settings.openchamber.pet.openFolderFailed'));
    }
  }, [petsDir, t]);

  // Shared success handler for create + edit. A new pet becomes the selection;
  // editing an existing pet must not hijack the active selection — but if the
  // active pet's sheet was just swapped, re-select it so the floating window
  // reloads the new spritesheet.
  const handleSaved = React.useCallback((slug: string) => {
    invalidateThumb(slug);
    void refreshPets();
    if (!editTarget || slug === selectedSlug) void selectPet(slug);
  }, [editTarget, invalidateThumb, refreshPets, selectPet, selectedSlug]);

  const handleDelete = React.useCallback(async (pet: PetListEntry) => {
    try {
      await invokeDesktop('desktop_pet_delete', { slug: pet.slug });
      invalidateThumb(pet.slug);
      // If the active pet was deleted, re-point to another (or sleep) so the
      // floating window never references a missing spritesheet.
      if (pet.slug === selectedSlug) {
        const next = pets.find((entry) => entry.slug !== pet.slug);
        if (next) {
          void selectPet(next.slug);
        } else {
          void setEnabled(false);
        }
      }
      await refreshPets();
      toast.success(t('settings.openchamber.pet.deleteSuccess'));
    } catch {
      toast.error(t('settings.openchamber.pet.deleteFailed'));
    } finally {
      setDeleteTarget(null);
    }
  }, [invalidateThumb, pets, refreshPets, selectPet, selectedSlug, setEnabled, t]);

  return (
    <section className="px-2 pb-2 pt-0 space-y-3">
      <span className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.pet.section')}</span>

      <div className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
        {/* Header toolbar */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-b border-[var(--interactive-border)] px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={openCreate}>
            {t('settings.openchamber.pet.createOwn')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refreshPets()}>
            {t('settings.openchamber.pet.refresh')}
          </Button>
          <div data-settings-item="pet.enabled">
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled && pets.length === 0}
              aria-pressed={enabled}
              onClick={handleWakeToggle}
            >
              {enabled ? t('settings.openchamber.pet.sleep') : t('settings.openchamber.pet.wake')}
            </Button>
          </div>
        </div>

        {/* Installed pets list */}
        {pets.length === 0 ? (
          <p className="px-3 py-8 text-center typography-meta text-muted-foreground/70">
            {t('settings.openchamber.pet.empty')}
          </p>
        ) : (
          <div data-settings-item="pet.select" className="divide-y divide-[var(--interactive-border)]">
            {pets.map((pet) => {
              const isSelected = pet.slug === selectedSlug;
              const thumb = thumbs[pet.slug];
              return (
                <div key={pet.slug} className="flex items-center gap-3 px-3 py-3">
                  <span
                    aria-hidden
                    className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background"
                  >
                    {thumb ? <PetSprite spritesheetDataUrl={thumb} state="idle" scale={THUMB_SCALE} /> : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="typography-ui-label text-foreground truncate">{pet.displayName}</div>
                    {pet.description ? (
                      <div className="typography-meta text-muted-foreground truncate">{pet.description}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('settings.openchamber.pet.edit.aria', { name: pet.displayName })}
                      onClick={() => openEdit(pet)}
                    >
                      <Icon name="edit" className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('settings.openchamber.pet.delete.aria', { name: pet.displayName })}
                      onClick={() => setDeleteTarget(pet)}
                    >
                      <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                    {isSelected ? (
                      <span className="inline-flex min-w-[4.5rem] items-center justify-center lowercase typography-ui-label text-muted-foreground/70">
                        {t('settings.openchamber.pet.selected')}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-[4.5rem]"
                        aria-label={t('settings.openchamber.pet.selectAria', { name: pet.displayName })}
                        onClick={() => handleSelect(pet.slug)}
                      >
                        {t('settings.openchamber.pet.selectAction')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Custom pets folder footer */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--interactive-border)] px-3 py-2.5">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">{t('settings.openchamber.pet.customPets')}</div>
            {petsDir ? (
              <div className="truncate font-mono typography-micro text-muted-foreground/70">{petsDir}</div>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" className="shrink-0" disabled={!petsDir} onClick={() => void handleOpenFolder()}>
            {t('settings.openchamber.pet.openFolder')}
            <Icon name="external-link" className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <CreatePetDialog
        open={dialogOpen}
        editTarget={editTarget}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) setEditTarget(null);
        }}
        onSaved={handleSaved}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('settings.openchamber.pet.delete.title')}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t('settings.openchamber.pet.delete.description', { name: deleteTarget.displayName })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('settings.openchamber.pet.create.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (deleteTarget) void handleDelete(deleteTarget); }}
            >
              {t('settings.openchamber.pet.delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
