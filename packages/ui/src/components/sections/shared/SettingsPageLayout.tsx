import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getSettingsSaveState, subscribeToSettingsSaveState } from '@/lib/persistence';
import { cn } from '@/lib/utils';

interface SettingsPageLayoutProps {
  /** Page content */
  children: React.ReactNode;
  /** Optional page title shown above settings content. */
  title?: string;
  /** Optional supporting description under the page title. */
  description?: string;
  /** Show persistence feedback for instant-save settings. */
  showSaveStatus?: boolean;
  /** Additional className for the content container */
  className?: string;
  /** Additional className for the outer ScrollableOverlay */
  outerClassName?: string;
}

/**
 * Standard layout wrapper for settings page content.
 * Provides scrolling and centered max-width container.
 *
 * @example
 * <SettingsPageLayout title="Appearance" description="..." showSaveStatus>
 *   ...
 * </SettingsPageLayout>
 */
export const SettingsPageLayout: React.FC<SettingsPageLayoutProps> = ({
  children,
  className,
  outerClassName,
  title,
  description,
  showSaveStatus = false,
}) => {
  return (
    <ScrollableOverlay
      outerClassName={cn('h-full', outerClassName)}
      className="w-full"
    >
      <div
        className={cn(
          'mx-auto max-w-4xl space-y-8 p-3 sm:p-6 sm:pt-8',
          className
        )}
      >
        {(title || description || showSaveStatus) && (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              {title ? (
                <h1 className="typography-ui-header font-semibold text-foreground">{title}</h1>
              ) : null}
              {description ? (
                <p className="typography-meta text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {showSaveStatus && <SettingsSaveStatus />}
          </div>
        )}
        {children}
      </div>
    </ScrollableOverlay>
  );
};

const SettingsSaveStatus: React.FC = () => {
  const { t } = useI18n();
  const status = React.useSyncExternalStore(
    subscribeToSettingsSaveState,
    getSettingsSaveState,
    getSettingsSaveState,
  );

  if (status === 'idle') {
    return null;
  }

  const isSaving = status === 'saving';

  return (
    <div
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-1.5 typography-meta',
        isSaving ? 'text-muted-foreground' : 'text-[var(--status-success)]',
      )}
    >
      <Icon
        name={isSaving ? 'loader-4' : 'check'}
        className={cn('size-3.5', isSaving && 'animate-spin')}
      />
      <span>{isSaving ? t('settings.common.actions.saving') : t('settings.common.status.saved')}</span>
    </div>
  );
};
