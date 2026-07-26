import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getSettingsSaveState, subscribeToSettingsSaveState } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';

interface SettingsPageLayoutProps {
  /** Page content */
  children: React.ReactNode;
  /** Optional page title shown above settings content. */
  title?: React.ReactNode;
  /** Optional content rendered before a string/number page title. */
  titleLeading?: React.ReactNode;
  /** Optional content rendered after a string/number page title. */
  titleAccessory?: React.ReactNode;
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
 * UI Kit: max-width 840px, padding 32px vertical / 48px horizontal.
 */
export const SettingsPageLayout: React.FC<SettingsPageLayoutProps> = ({
  children,
  className,
  outerClassName,
  title,
  titleLeading,
  titleAccessory,
  description,
  headerEnd,
  showSaveStatus = false,
}) => {
  const hasHeader = title != null || description != null || headerEnd != null || showSaveStatus;
  const isPlainTitle = typeof title === 'string' || typeof title === 'number';
  const hasTitleChrome = titleLeading != null || titleAccessory != null;

  return (
    <ScrollableOverlay
      outerClassName={cn('h-full', outerClassName)}
      className="w-full @container"
    >
      <div
        className={cn(
          'mx-auto max-w-[840px] space-y-0 px-6 py-6 @3xl:px-12 @3xl:py-8',
          // The first visible section never needs the top divider, no matter
          // which platform-conditional sections above it rendered null.
          '[&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0',
          className
        )}
      >
        {hasHeader && (
          <div className="mb-2 flex items-start justify-between gap-4 pb-6">
            <div className="min-w-0 space-y-1">
              {title != null ? (
                isPlainTitle ? (
                  hasTitleChrome ? (
                    <div className="flex min-w-0 items-center gap-2">
                      {titleLeading}
                      <h1 className={cn(SETTINGS_PAGE_TITLE_CLASS, 'min-w-0 truncate')}>{title}</h1>
                      {titleAccessory}
                    </div>
                  ) : (
                    <h1 className={SETTINGS_PAGE_TITLE_CLASS}>{title}</h1>
                  )
                ) : (
                  title
                )
              ) : null}
              {description != null ? (
                typeof description === 'string' || typeof description === 'number' ? (
                  <p className={SETTINGS_DESCRIPTION_CLASS}>{description}</p>
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

// Only saves slower than this surface a "Saving…" spinner — local writes
// finish instantly and stay silent; remote/mobile connections get feedback.
const SAVE_SPINNER_DELAY_MS = 500;

const SettingsSaveStatus: React.FC = () => {
  const { t } = useI18n();
  const status = React.useSyncExternalStore(
    subscribeToSettingsSaveState,
    getSettingsSaveState,
    getSettingsSaveState,
  );
  const [showSaving, setShowSaving] = React.useState(false);

  React.useEffect(() => {
    if (status !== 'saving') {
      setShowSaving(false);
      return;
    }
    const timer = setTimeout(() => setShowSaving(true), SAVE_SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === 'error') {
    return (
      <div
        aria-live="assertive"
        className="flex shrink-0 items-center gap-1.5 typography-meta text-[var(--status-error)]"
      >
        <Icon name="error-warning" className="size-3.5" />
        <span>{t('settings.common.status.saveFailed')}</span>
      </div>
    );
  }

  if (status !== 'saving' || !showSaving) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="flex shrink-0 items-center gap-1.5 typography-meta text-muted-foreground"
    >
      <Icon name="loader-4" className="size-3.5 animate-spin" />
      <span>{t('settings.common.actions.saving')}</span>
    </div>
  );
};
