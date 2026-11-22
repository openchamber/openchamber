import React from 'react';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useContextPanelDetach } from './useContextPanelDetach';

export const ContextZoneWindowButtons: React.FC<{
  expandable: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}> = ({ expandable, expanded, onToggleExpanded }) => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const detachPanel = useContextPanelDetach();
  const expandLabel = expanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel');
  return (
    <>
      {detachPanel.available ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={detachPanel.detach}
              className="h-7 w-7 p-0"
              aria-label={t('contextPanel.window.open')}
            >
              <Icon name="external-link" className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('contextPanel.window.open')}</TooltipContent>
        </Tooltip>
      ) : null}
      {expandable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="sm" onClick={onToggleExpanded} className="h-7 w-7 p-0" aria-label={expandLabel}>
              <Icon name={expanded ? 'fullscreen-exit' : 'fullscreen'} className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            <TooltipLabelWithShortcut label={expandLabel} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_context_panel_expanded', shortcutOverrides), '')} />
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
};
