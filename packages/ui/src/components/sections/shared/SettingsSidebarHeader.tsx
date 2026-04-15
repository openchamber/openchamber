import React from 'react';
import { Button } from '@/components/ui/button';
import { RiAddLine } from '@remixicon/react';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';

interface SettingsSidebarHeaderProps {
  /** Total count to display (e.g., "Total 5") */
  count: number;
  /** Callback when add button is clicked. If undefined, no add button is shown. */
  onAdd?: () => void;
  /** Custom label prefix (default: "Total") */
  label?: string;
  /** Aria label for the add button */
  addButtonLabel?: string;
}

/**
 * Standard header for settings sidebars.
 * Displays "Total X" on the left and an optional add button on the right.
 *
 * @example
 * <SettingsSidebarHeader
 *   count={agents.length}
 *   onAdd={() => setCreateDialogOpen(true)}
 *   addButtonLabel="Create new agent"
 * />
 */
export const SettingsSidebarHeader: React.FC<SettingsSidebarHeaderProps> = ({
  count,
  onAdd,
  label = m.settingsSidebarTotal(),
  addButtonLabel = m.settingsSidebarAddNewItem(),
}) => {
  const { isMobile } = useDeviceInfo();

  return (
    <div
      className={cn(
        'border-b px-3',
        isMobile ? 'mt-2 py-3' : 'py-3'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="typography-meta text-muted-foreground">
          {label} {count}
        </span>
        {onAdd && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 -my-1 text-muted-foreground"
            onClick={onAdd}
            aria-label={addButtonLabel}
          >
            <RiAddLine className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
};
