import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { KNOWLEDGE_ICON_BUTTON_CLASS, useKnowledgeRevealClass } from './knowledgeRowStyle';

/** Attaches a note or plan to the current session's context. */
export const KnowledgePinToggle: React.FC<{
  pinned: boolean;
  onToggle: () => void;
  /** An opened entry shows its controls without waiting for hover. */
  alwaysVisible?: boolean;
}> = ({ pinned, onToggle, alwaysVisible = false }) => {
  const { t } = useI18n();
  const hoverReveal = useKnowledgeRevealClass();
  const reveal = alwaysVisible ? '' : hoverReveal;
  const label = pinned
    ? t('rightSidebar.contextNotesTodo.pin.detach')
    : t('rightSidebar.contextNotesTodo.pin.attach');
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, pinned ? 'text-primary hover:text-primary' : reveal)}
      aria-pressed={pinned}
      aria-label={label}
      data-row-tooltip={label}
    >
      {/* Filled while attached; the outline offers to attach. */}
      <Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3.5 w-3.5" />
    </button>
  );
};

export type KnowledgeMenuItem = {
  id: string;
  label: string;
  /** A longer explanation shown as the item's tooltip. */
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export const KnowledgeMenu: React.FC<{
  items: KnowledgeMenuItem[];
  disabled?: boolean;
  /** An opened entry shows its controls without waiting for hover. */
  alwaysVisible?: boolean;
}> = ({ items, disabled, alwaysVisible = false }) => {
  const { t } = useI18n();
  const hoverReveal = useKnowledgeRevealClass();
  // A list row's menu is its right click with a mouse (`KnowledgeRowContextMenu`),
  // so its ⋯ shows on touch screens only. An opened entry keeps its toolbar ⋯.
  const reveal = alwaysVisible ? '' : cn(hoverReveal, 'pointer-fine:hidden');
  const label = t('rightSidebar.contextNotesTodo.actions.more');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, reveal)}
          aria-label={label}
          data-row-tooltip={label}
        >
          <Icon name="more" className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            variant={item.destructive ? 'destructive' : 'default'}
            disabled={item.disabled}
            title={item.hint}
            onClick={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * A list row's right-click menu: the same items as its ⋯ menu. `render` is the
 * row element itself, so a list item stays the list's direct child.
 */
export const KnowledgeRowContextMenu: React.FC<{
  items: KnowledgeMenuItem[];
  disabled?: boolean;
  render: React.ReactElement;
  children: React.ReactNode;
}> = ({ items, disabled, render, children }) => (
  <ContextMenu disabled={disabled}>
    <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
    <ContextMenuContent className="min-w-48">
      {items.map((item) => (
        <ContextMenuItem
          key={item.id}
          className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
          disabled={item.disabled}
          title={item.hint}
          onClick={item.onSelect}
        >
          {item.label}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  </ContextMenu>
);
