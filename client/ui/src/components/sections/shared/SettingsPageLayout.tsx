import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';

interface SettingsPageLayoutProps {
  /** Page content */
  children: React.ReactNode;
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
        {children}
      </div>
    </ScrollableOverlay>
  );
};
