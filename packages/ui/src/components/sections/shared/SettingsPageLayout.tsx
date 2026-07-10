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
  title?: React.ReactNode;
  /** Optional supporting description under the page title. */
  description?: React.ReactNode;
  /** Optional content rendered at the end of the header row (before save status). */
  headerEnd?: React.ReactNode;
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
 */
export const SettingsPageLayout: React.FC<SettingsPageLayoutProps> = ({
  children,
  className,
  outerClassName,
  title,
  description,
  headerEnd,
  showSaveStatus = false,
}) => {
  const hasHeader = title != null || description != null || headerEnd != null || showSaveStatus;

  return (
    <ScrollableOverlay
      outerClassName={cn('h-full', outerClassName)}
      className="w-full"
    >
      <div
        className={cn(
          'mx-auto max-w-4xl space-y-0 p-3 sm:p-6 sm:pt-8',
          className
        )}
      >
        {hasHeader && (
          <div className="mb-2 flex items-start justify-between gap-4 pb-6">
            <div className="min-w-0 space-y-1">
              {title != null ? (
                typeof title === 'string' || typeof title === 'number' ? (
                  <h1 className="typography-ui-header font-semibold text-foreground">{title}</h1>
                ) : (
                  title
                )
              ) : null}
              {description != null ? (
                typeof description === 'string' || typeof description === 'number' ? (
                  <p className="typography-meta text-muted-foreground">{description}</p>
                ) : (
                  description
                )
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {headerEnd}
              {showSaveStatus && <SettingsSaveStatus />}
            </div>
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
