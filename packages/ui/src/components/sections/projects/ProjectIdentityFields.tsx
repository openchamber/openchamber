import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsFieldRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { useConfigStore } from '@/stores/useConfigStore';
import { modelVariantNames } from '@/lib/modelVariants';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type ProjectIdentityFieldsProps = {
  form: ProjectIdentityFormState;
};

const NO_VARIANT_VALUE = '__default__';

const formatVariantLabel = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

export const ProjectIdentityFields: React.FC<ProjectIdentityFieldsProps> = ({ form }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const providers = useConfigStore((state) => state.providers);
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
    defaultVariant,
    handleDefaultModelChange,
    handleDefaultVariantChange,
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

  const availableVariants = React.useMemo(() => {
    const { providerId, modelId } = parsedDefaultModel;
    if (!providerId || !modelId) return [];
    const model = providers
      .find((provider) => provider.id === providerId)
      ?.models.find((entry) => entry.id === modelId);
    return modelVariantNames(model);
  }, [parsedDefaultModel, providers]);

  if (!project) {
    return null;
  }

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;

  return (
    <>
      <ProjectSettingsSubsection
        title={t('settings.projects.page.field.projectName')}
        settingsItem="projects.name"
        divider={false}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('settings.projects.page.field.projectNamePlaceholder')}
          className={cn('h-8 rounded-md px-3', PROJECT_SETTINGS_CONTROL_WIDTH)}
        />
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.chatDefaults')}
        info={t('settings.projects.page.section.chatDefaultsDescription')}
        contentClassName="space-y-0"
      >
        <SettingsFieldRow
          settingsItem="projects.default-model"
          label={t('settings.projects.page.field.projectModel')}
        >
          <ModelSelector
            providerId={parsedDefaultModel.providerId}
            modelId={parsedDefaultModel.modelId}
            onChange={handleDefaultModelChange}
            className={SETTINGS_CUSTOM_TRIGGER_CLASS}
          />
        </SettingsFieldRow>

        {availableVariants.length > 0 ? (
          <SettingsFieldRow
            settingsItem="projects.default-thinking"
            label={t('settings.projects.page.field.projectThinking')}
          >
            <Select
              value={defaultVariant ?? NO_VARIANT_VALUE}
              onValueChange={(value) => handleDefaultVariantChange(value === NO_VARIANT_VALUE ? undefined : value)}
            >
              <SelectTrigger
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={t('settings.projects.page.field.projectThinking')}
              >
                <SelectValue>
                  {defaultVariant
                    ? formatVariantLabel(defaultVariant)
                    : t('settings.projects.page.option.thinkingDefault')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VARIANT_VALUE}>{t('settings.projects.page.option.thinkingDefault')}</SelectItem>
                {availableVariants.map((variant) => (
                  <SelectItem key={variant} value={variant}>{formatVariantLabel(variant)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        ) : null}
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title={t('settings.projects.page.field.accentColor')}
        settingsItem="projects.accent-color"
      >
        <div className="flex flex-wrap items-center gap-2">
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
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title={t('settings.projects.page.field.projectIcon')}
        settingsItem="projects.icon"
        contentClassName="space-y-3"
      >
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
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex items-center gap-2">
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
          <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex flex-wrap items-center gap-2">
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
      </ProjectSettingsSubsection>
    </>
  );
};
