import React from 'react';
import { cn } from '@/lib/utils';

export const PROJECT_SETTINGS_CONTROL_WIDTH = 'w-full max-w-[30rem]';

type ProjectSettingsSubsectionProps = {
  title: string;
  description?: string;
  settingsItem?: string;
  titleAccessory?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

export const ProjectSettingsSubsection: React.FC<ProjectSettingsSubsectionProps> = ({
  title,
  description,
  settingsItem,
  titleAccessory,
  headerAction,
  children,
  className,
  contentClassName,
}) => {
  return (
    <section
      data-settings-item={settingsItem}
      className={cn('border-b border-border/50 py-5 first:pt-0 last:border-b-0', className)}
    >
      <div className="mb-3 flex items-start justify-between gap-3 px-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">{title}</h3>
            {titleAccessory}
          </div>
          {description ? (
            <p className="mt-0.5 typography-meta text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      <div className={cn('space-y-2 px-2', contentClassName)}>{children}</div>
    </section>
  );
};
