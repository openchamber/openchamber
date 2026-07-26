import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';

export { PROJECT_SETTINGS_CONTROL_WIDTH } from './projectSettingsConstants';

type ProjectSettingsSubsectionProps = {
  title: string;
  description?: string;
  /** Helper text hidden behind an info icon next to the title. */
  info?: React.ReactNode;
  settingsItem?: string;
  titleAccessory?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** Use false for the first subsection under a page header. @default true */
  divider?: boolean;
};

export const ProjectSettingsSubsection: React.FC<ProjectSettingsSubsectionProps> = ({
  title,
  description,
  info,
  settingsItem,
  titleAccessory,
  headerAction,
  children,
  className,
  contentClassName,
  divider = true,
}) => {
  return (
    <SettingsSection
      title={title}
      description={description}
      info={info}
      settingsItem={settingsItem}
      titleAccessory={titleAccessory}
      headerAction={headerAction}
      divider={divider}
      className={className}
      contentClassName={contentClassName}
    >
      {children}
    </SettingsSection>
  );
};
