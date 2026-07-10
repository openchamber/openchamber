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
 * <SettingsPageLayout>
 *   <SettingsSection title="General">
 *     <SomeSettingsForm />
 *   </SettingsSection>
 *   <SettingsSection title="Advanced" divider>
 *     <OtherSettingsForm />
 *   </SettingsSection>
 * </SettingsPageLayout>
 */
export const SettingsPageLayout: React.FC<SettingsPageLayoutProps> = ({
  children,
  className,
  outerClassName,
  title,
  showSaveStatus = false,
}) => {
  return (
    <ScrollableOverlay
      outerClassName={cn('h-full', outerClassName)}
      className="w-full"
    >
      <div
        className={cn(
          'mx-auto max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8',
          className
        )}
      >
        {(title || showSaveStatus) && (
          <div className="flex items-center justify-between gap-4 border-b border-border/40 pb-4">
            {title ? (
              <h1 className="typography-ui-header font-semibold text-foreground">{title}</h1>
            ) : <span />}
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

  return (
    <div aria-live="polite" className="flex shrink-0 items-center gap-1.5 typography-meta text-muted-foreground">
      <Icon name={status === 'saving' ? 'loader-4' : 'check'} className={cn('size-3.5', status === 'saving' && 'animate-spin')} />
      <span>{status === 'saving' ? t('settings.common.actions.saving') : t('settings.common.status.saved')}</span>
    </div>
  );
};
