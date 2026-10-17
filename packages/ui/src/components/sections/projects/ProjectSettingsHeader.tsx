import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { SettingsColorField } from '@/components/sections/shared/SettingsColorField';
import {
  SettingsChipGroup,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  PROJECT_ICONS,
  PROJECT_ICON_MAP,
  ProjectIconImage,
  iconBackgroundForProjectColor,
  resolveProjectColor,
} from '@/lib/projectMeta';
import { isHexColor } from '@/lib/colorPresets';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type IconMode = 'symbol' | 'image';

/** The project's icon as the sidebar draws it, from the form's unsaved state. */
const ProjectIconPreview: React.FC<{ form: ProjectIdentityFormState; className?: string }> = ({ form, className }) => {
  const { currentTheme } = useThemeSystem();
  const { project } = form;
  if (!project) return null;

  if (form.effectiveHasImageIcon && form.showImagePreview) {
    return (
      <span
        className={cn('inline-flex items-center justify-center overflow-hidden rounded-[4px]', className)}
        style={form.iconBackground ? { backgroundColor: form.iconBackground } : undefined}
      >
        {form.hasPendingUploadImageIcon && form.pendingUploadIconPreviewUrl ? (
          <img
            src={form.pendingUploadIconPreviewUrl}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => form.setPreviewImageFailed(true)}
          />
        ) : (
          <ProjectIconImage
            project={{ ...project, iconImage: form.currentIconImage ?? project.iconImage }}
            options={{
              themeVariant: currentTheme.metadata.variant,
              iconColor: currentTheme.colors.surface.foreground,
            }}
            className="h-full w-full object-contain"
            onError={() => form.setPreviewImageFailed(true)}
          />
        )}
      </span>
    );
  }

  const color = resolveProjectColor(form.color);
  return (
    <Icon
      name={(form.icon ? PROJECT_ICON_MAP[form.icon] : null) ?? 'folder'}
      className={cn(className, !color && 'text-muted-foreground')}
      style={color ? { color } : undefined}
    />
  );
};

const ICON_CELL_CLASS = 'flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]';

/** Colour and icon, edited together: the colour paints the symbol and fills the background behind an image. */
const ProjectAppearancePicker: React.FC<{
  form: ProjectIdentityFormState;
  onUploadClick: () => void;
}> = ({ form, onUploadClick }) => {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<IconMode>(form.effectiveHasImageIcon ? 'image' : 'symbol');
  const legacyCss = form.color && !isHexColor(form.color) ? resolveProjectColor(form.color) : null;

  const pickColor = (next: string) => {
    const color = next || null;
    form.setColor(color);
    form.setIconBackground(iconBackgroundForProjectColor(color));
  };

  const pickSymbol = (key: string | null) => {
    form.setIcon(key);
    // The sidebar draws the image whenever there is one, so a symbol needs it gone.
    if (form.effectiveHasImageIcon) form.handleRemoveImageIcon();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.projects.appearance.color')}</div>
        <SettingsColorField
          value={form.color ?? ''}
          onChange={pickColor}
          legacyCss={legacyCss}
          labels={{
            empty: t('settings.projects.appearance.colorNone'),
            swatch: (color) => t('settings.projects.appearance.colorSwatchAria', { color }),
            custom: t('settings.projects.appearance.colorCustomAria'),
            hex: t('settings.projects.appearance.colorHexAria'),
          }}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.projects.appearance.icon')}</div>
          <SettingsChipGroup<IconMode>
            value={mode}
            onChange={setMode}
            aria-label={t('settings.projects.appearance.icon')}
            options={[
              { value: 'symbol', label: t('settings.projects.appearance.mode.symbol') },
              { value: 'image', label: t('settings.projects.appearance.mode.image') },
            ]}
          />
        </div>

        {mode === 'symbol' ? (
          <div className="grid grid-cols-8 gap-1">
            {[{ key: null, Icon: 'folder' as const, label: t('settings.projects.appearance.symbolNone') }, ...PROJECT_ICONS].map((entry) => {
              const selected = !form.effectiveHasImageIcon && form.icon === entry.key;
              return (
                <button
                  key={entry.key ?? 'none'}
                  type="button"
                  onClick={() => pickSymbol(entry.key)}
                  aria-pressed={selected}
                  aria-label={entry.label}
                  title={entry.label}
                  className={cn(
                    ICON_CELL_CLASS,
                    selected
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : 'text-foreground hover:bg-[var(--interactive-hover)]',
                  )}
                >
                  <Icon name={entry.Icon} className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {form.effectiveHasImageIcon ? (
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center oc-tile-inset rounded-xl">
                  <ProjectIconPreview form={form} className="h-7 w-7" />
                </span>
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.projects.appearance.imageColorHint')}</p>
              </div>
            ) : (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.projects.appearance.imageEmpty')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {!form.hasCustomIcon ? (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={onUploadClick} disabled={form.isUploadingIcon}>
                    {form.isUploadingIcon ? t('settings.projects.page.actions.uploading') : t('settings.projects.page.actions.uploadIcon')}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void form.handleDiscoverIcon()} disabled={form.isDiscoveringIcon}>
                    {form.isDiscoveringIcon ? t('settings.projects.page.actions.discovering') : t('settings.projects.page.actions.discoverFavicon')}
                  </Button>
                </>
              ) : null}
              {form.hasRemovableImageIcon ? (
                <Button type="button" size="sm" variant="ghost" className="text-[var(--status-error)]" onClick={form.handleRemoveImageIcon} disabled={form.isRemovingCustomIcon}>
                  {form.isRemovingCustomIcon ? t('settings.projects.page.actions.removing') : t('settings.projects.page.actions.removeProjectIcon')}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The top of the project page: the icon, which opens the colour and icon
 * picker, the name, edited in place, and the path.
 */
export const ProjectSettingsHeader: React.FC<{ form: ProjectIdentityFormState }> = ({ form }) => {
  const { t } = useI18n();
  const fileInputRef = form.fileInputRef;
  // Inside the Settings dialog the popup portals into the dialog, or the
  // dialog's focus trap and stacking would hide it.
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const syncPortal = (target: EventTarget | null) => {
    const dialog = target instanceof HTMLElement ? target.closest('[data-slot="dialog-content"], [role="dialog"]') : null;
    setPortalContainer(dialog instanceof HTMLElement ? dialog : null);
  };

  if (!form.project) return null;

  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* Outside the popup: the system file picker takes focus, which closes the popup. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          form.handleUploadIcon(file);
          event.currentTarget.value = '';
        }}
      />
      <Popover.Root>
        <Popover.Trigger
          data-settings-item="projects.icon"
          aria-label={t('settings.projects.header.appearanceAria')}
          title={t('settings.projects.header.appearanceAria')}
          onPointerDownCapture={(event) => syncPortal(event.currentTarget)}
          onFocusCapture={(event) => syncPortal(event.currentTarget)}
          className="relative flex h-12 w-12 shrink-0 items-center justify-center oc-tile-inset rounded-xl hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] data-[popup-open]:bg-interactive-selection"
        >
          <ProjectIconPreview form={form} className="h-6 w-6" />
          {/* Says the tile is a control: it opens the icon and colour picker. */}
          <span
            aria-hidden="true"
            className="absolute -bottom-1 -end-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--interactive-border)] bg-background text-muted-foreground"
          >
            <Icon name="pencil" className="h-2.5 w-2.5" />
          </span>
        </Popover.Trigger>
        <Popover.Portal container={portalContainer ?? undefined}>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-[120]">
            <Popover.Popup
              aria-label={t('settings.projects.header.appearanceAria')}
              className={cn(dropdownMenuPopupClass, 'w-[22.5rem] max-w-[calc(100vw-2rem)] p-3')}
            >
              <ProjectAppearancePicker form={form} onUploadClick={() => fileInputRef.current?.click()} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {/* Name and path together are as tall as the tile, so the three read as one block. */}
      <div className="min-w-0 flex-1 space-y-0.5">
        <Input
          data-settings-item="projects.name"
          inputSize="compact"
          value={form.name}
          onChange={(event) => form.setName(event.target.value)}
          placeholder={t('settings.projects.page.field.projectNamePlaceholder')}
          aria-label={t('settings.projects.page.field.projectName')}
          className="-ms-2 w-full max-w-[24rem] bg-transparent px-2 [&:not(:hover):not(:focus)]:shadow-none typography-settings-section-title md:typography-settings-section-title"
        />
        <p className="truncate typography-meta text-muted-foreground" title={form.project.path}>
          {form.project.path}
        </p>
      </div>
    </div>
  );
};
