import React from 'react';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useOpenSuggestionCount } from '@/stores/useSuggestedTasksStore';
import { sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import type { SidebarPage } from './useSidebarPages';

function SuggestedTasksLabel({ visible }: { readonly visible: boolean }) {
  const { t } = useI18n();
  const count = useOpenSuggestionCount(visible);
  return <>{count > 0 ? t('suggestedTasks.sidebar.openWithCount', { count }) : t('suggestedTasks.sidebar.open')}</>;
}

/**
 * One page under the Pages caption, drawn as a one-line session row: the icon
 * in the tree's slot, so the label starts where session titles do. Pressing it
 * opens the page, or closes it while it is open (the selected fill).
 */
export const SidebarPageRow: React.FC<{ page: SidebarPage; visible: boolean }> = ({ page, visible }) => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const shortcut = page.shortcut ? formatShortcutForDisplay(getEffectiveShortcutCombo(page.shortcut, shortcutOverrides), '') : '';
  const row = (
    <button
      type="button"
      onClick={page.toggle}
      aria-pressed={page.open}
      style={{ paddingInlineStart: sessionTreeRowPaddingLeft(0) }}
      className={cn(
        'my-px flex w-full items-center gap-1.5 rounded-md py-[5px] pe-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        page.open ? 'oc-selected text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
      )}
    >
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <GuestIcon icon={page.icon} iconSrc={page.iconSrc ?? undefined} className="size-3.5" />
      </span>
      <span className={cn('min-w-0 flex-1 truncate typography-ui-label', page.open ? 'text-interactive-selection-foreground' : 'oc-title-rest')} dir="auto">
        {page.id === 'suggested' ? <SuggestedTasksLabel visible={visible} /> : page.label}
      </span>
    </button>
  );
  if (!shortcut) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="top">
        <TooltipLabelWithShortcut label={page.label} shortcut={shortcut} />
      </TooltipContent>
    </Tooltip>
  );
};
