import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

export const SettingsSplitStage = ({ showSidebar, sidebar, content }: {
  showSidebar: boolean;
  sidebar: ReactNode;
  content: ReactNode | null;
}) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
    <div className={cn('flex min-h-0 flex-1 flex-col', !showSidebar && 'hidden')}>
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="bg-background" disableHorizontal>
        <ErrorBoundary>{sidebar}</ErrorBoundary>
      </ScrollableOverlay>
    </div>
    {content === null ? null : (
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="bg-background" disableHorizontal>
        <ErrorBoundary>{content}</ErrorBoundary>
      </ScrollableOverlay>
    )}
  </div>
);
