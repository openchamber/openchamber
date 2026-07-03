import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type ProjectIdentityFieldsProps = {
  form: ProjectIdentityFormState;
};

export const ProjectIdentityFields: React.FC<ProjectIdentityFieldsProps> = ({ form }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const {
    name,
    setName,
    icon,
    setIcon,
    color,
    setColor,
    iconBackground,
    setIconBackground,
    parsedDefaultModel,
    handleDefaultModelChange,
    isUploadingIcon,
    isRemovingCustomIcon,
    isDiscoveringIcon,
    pendingRemoveImageIcon,
    setPendingRemoveImageIcon,
    pendingUploadIconPreviewUrl,
    setPreviewImageFailed,
    hasPendingUploadImageIcon,
    hasCustomIcon,
    effectiveHasImageIcon,
    hasRemovableImageIcon,
    showImagePreview,
    fileInputRef,
    handleUploadIcon,
    handleRemoveImageIcon,
    handleDiscoverIcon,
    currentIconImage,
    project,
  } = form;

  if (!project) {
    return null;
  }

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;

  return (
    <section className="px-2 pb-2 pt-0 space-y-0.5">
      <div data-settings-item="projects.name" className="py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.projectName')}</span>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('settings.projects.page.field.projectNamePlaceholder')}
            className="h-7 min-w-0 w-full sm:max-w-[19rem]"
          />
        </div>
      </div>

      <div data-settings-item="projects.default-model" className="py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.defaultModel')}</span>
          <span className="typography-meta text-muted-foreground">{t('settings.projects.page.field.defaultModelDescription')}</span>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <ModelSelector
            providerId={parsedDefaultModel.providerId}
            modelId={parsedDefaultModel.modelId}
            onChange={handleDefaultModelChange}
          />
        </div>
      </div>

      <div data-settings-item="projects.accent-color" className="py-1.5">
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
                : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]',
            )}
            title={t('settings.projects.page.field.none')}
          >
            <Icon name="close" className="h-4 w-4 text-muted-foreground" />
          </button>
          {PROJECT_COLORS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setColor(entry.key)}
              className={cn(
                'h-7 w-7 rounded-md border transition-colors',
                color === entry.key
                  ? 'border-2 border-foreground ring-1 ring-[var(--primary-base)]/40'
                  : 'border-transparent hover:border-border/70',
              )}
              style={{ backgroundColor: entry.cssVar }}
              title={entry.label}
            />
          ))}
        </div>
      </div>

      <div data-settings-item="projects.icon" className="py-1.5">
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
                : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]',
            )}
            title={t('settings.projects.page.field.none')}
          >
            <Icon name="close" className="h-4 w-4 text-muted-foreground" />
          </button>
          {PROJECT_ICONS.map((entry) => {
            const iconName = entry.Icon;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setIcon(entry.key)}
                className={cn(
                  'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                  icon === entry.key
                    ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                    : 'border-transparent hover:border-border hover:bg-[var(--surface-muted)]',
                )}
                title={entry.label}
              >
                <Icon
                  name={iconName}
                  className="w-4 h-4"
                  style={currentColorVar && icon === entry.key ? { color: currentColorVar } : undefined}
                />
              </button>
            );
          })}
        </div>
        {effectiveHasImageIcon && showImagePreview && (
          <div className="mt-2 flex items-center gap-2">
            <span className="typography-meta text-muted-foreground">{t('settings.projects.page.field.preview')}</span>
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-[var(--surface-elevated)] p-1">
              <span
                className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
                style={iconBackground ? { backgroundColor: iconBackground } : undefined}
              >
                {hasPendingUploadImageIcon && pendingUploadIconPreviewUrl ? (
                  <img
                    src={pendingUploadIconPreviewUrl}
                    alt=""
                    className="h-full w-full object-contain"
                    draggable={false}
                    onError={() => setPreviewImageFailed(true)}
                  />
                ) : (
                  <ProjectIconImage
                    project={{ ...project, iconImage: currentIconImage ?? project.iconImage }}
                    options={{
                      themeVariant: currentTheme.metadata.variant,
                      iconColor: currentTheme.colors.surface.foreground,
                    }}
                    className="h-full w-full object-contain"
                    onError={() => setPreviewImageFailed(true)}
                  />
                )}
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
              <Icon name="close" className="h-3.5 w-3.5" />
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
  );
};
