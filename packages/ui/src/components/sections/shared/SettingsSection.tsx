import React from 'react';
import { cn } from '@/lib/utils';

/** Settings select trigger: kit-aligned width (pair with size="settings" for 36px height). */
export const SETTINGS_SELECT_TRIGGER_CLASS = 'w-full min-w-40 sm:w-56';
export const SETTINGS_SELECT_SIZE = 'settings' as const;

/** Minimum width for settings controls (160px). */
export const SETTINGS_CONTROL_MIN_CLASS = 'min-w-40';

/** Standard label column width for legacy row-aligned fields. */
export const SETTINGS_LABEL_COL_CLASS = 'w-full min-w-0 flex-1 basis-0 sm:pr-6';

interface SettingsSectionProps {
  /** Section title. Strings render as the shared h2 style. */
  title?: React.ReactNode;
  /** Optional supporting text under the title. */
  description?: React.ReactNode;
  /** Optional icon/badge next to the title. */
  titleAccessory?: React.ReactNode;
  /** Optional action aligned to the right of the header. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Show a top border divider.
   * Use `false` for the first section under the page header.
   * @default true
   */
  divider?: boolean;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

/**
 * Shared settings section chrome: single-style header + optional divider.
 */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  titleAccessory,
  headerAction,
  children,
  divider = true,
  className,
  contentClassName,
  settingsItem,
}) => {
  const hasHeader = title != null || description != null || headerAction != null;

  return (
    <section
      data-settings-item={settingsItem}
      className={cn(
        'space-y-4',
        divider ? 'border-t border-border/40 py-8' : 'pb-8',
        className,
      )}
    >
      {hasHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {title != null ? (
              <div className="flex items-center gap-2">
                {typeof title === 'string' || typeof title === 'number' ? (
                  <h2 className="typography-settings-title text-foreground">{title}</h2>
                ) : (
                  title
                )}
                {titleAccessory}
              </div>
            ) : null}
            {description != null ? (
              <div className="typography-settings-description text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
      ) : null}
      <div className={cn(contentClassName)}>{children}</div>
    </section>
  );
};

interface SettingsTwoColumnProps {
  children: React.ReactNode;
  className?: string;
}

/** Responsive two-column settings grid used when space allows. */
export const SettingsTwoColumn: React.FC<SettingsTwoColumnProps> = ({
  children,
  className,
}) => {
  return (
    <div className={cn('grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-10', className)}>
      {children}
    </div>
  );
};

interface SettingsFieldRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
}

/**
 * Form row: label + description on the left (flex-grow), control on the right.
 */
export const SettingsFieldRow: React.FC<SettingsFieldRowProps> = ({
  label,
  description,
  children,
  settingsItem,
  className,
  controlClassName,
}) => {
  return (
    <div
      data-settings-item={settingsItem}
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-0 sm:pr-6">
        <div className="typography-ui-label font-medium text-foreground">{label}</div>
        {description != null ? (
          <p className="typography-settings-description mt-1 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center justify-start sm:min-w-40 sm:justify-end',
          controlClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
};
