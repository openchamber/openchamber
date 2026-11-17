import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { getSettingsSaveState, subscribeToSettingsSaveState } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { SettingsScrollbarTopClearanceContext } from '@/components/sections/shared/settingsScrollbarClearance';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';

interface SettingsPageLayoutProps {
  children: React.ReactNode;
  title?: React.ReactNode;
  titleLeading?: React.ReactNode;
  titleAccessory?: React.ReactNode;
  description?: React.ReactNode;
  headerEnd?: React.ReactNode;
  showSaveStatus?: boolean;
  namedBySidebar?: boolean;
  onBlurCapture?: React.FocusEventHandler;
  className?: string;
  outerClassName?: string;
  fillHeight?: boolean;
}

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
  namedBySidebar = false,
  onBlurCapture,
  fillHeight = false,
}) => {
  const scrollbarTopClearance = React.useContext(SettingsScrollbarTopClearanceContext);
  const { isMobile } = useDeviceInfo();
  const hasHeader = title != null || description != null || headerEnd != null || showSaveStatus;
  const isPlainTitle = typeof title === 'string' || typeof title === 'number';
  const hasTitleChrome = titleLeading != null || titleAccessory != null;

  return (
    <ScrollableOverlay
      outerClassName={cn('h-full', outerClassName)}
      className={cn('w-full @container', fillHeight && 'flex flex-col')}
      verticalTrackStart={scrollbarTopClearance}
    >
      <div
        className={cn(
          'mx-auto max-w-[840px] space-y-0 px-6 py-6 @3xl:px-12 @3xl:py-8',
          fillHeight && 'flex w-full flex-1 flex-col',
          '[&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0',
          className
        )}
        onBlurCapture={onBlurCapture}
      >
        {namedBySidebar ? (
          <>
            {title != null ? <h1 data-settings-page-heading tabIndex={-1} className="sr-only">{title}</h1> : null}
            {headerEnd != null ? (
              <div className="mb-6 flex flex-wrap items-center justify-end gap-3">
                {headerEnd}
                {showSaveStatus && <SettingsSaveStatus />}
              </div>
            ) : showSaveStatus ? (
              <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-end">
                <div className="pointer-events-auto rounded-md bg-background px-1">
                  <SettingsSaveStatus />
                </div>
              </div>
            ) : null}
          </>
        ) : hasHeader && (
          <div className={cn(
            'flex flex-wrap items-start justify-between gap-x-4 gap-y-3',
            isMobile && description == null && headerEnd == null && !hasTitleChrome ? 'mb-0' : 'mb-2 pb-6',
          )}>
            <div className="min-w-0 flex-1 basis-64 space-y-1">
              {title != null ? (
                isPlainTitle ? (
                  hasTitleChrome ? (
                    <div className="flex min-w-0 items-center gap-2">
                      {titleLeading}
                      <h1 data-settings-page-heading tabIndex={-1} className={cn(SETTINGS_PAGE_TITLE_CLASS, 'min-w-0 truncate')}>{title}</h1>
                      <span className="shrink-0">{titleAccessory}</span>
                    </div>
                  ) : (
                    <h1 data-settings-page-heading tabIndex={-1} className={cn(SETTINGS_PAGE_TITLE_CLASS, isMobile && 'sr-only')}>{title}</h1>
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
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
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
