import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
      title={label}
    >
      {/* Filled while attached; the outline offers to attach. */}
      <Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3.5 w-3.5" />
    </button>
  );
};

type KnowledgeMenuItem = {
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
  const reveal = alwaysVisible ? '' : hoverReveal;
  const label = t('rightSidebar.contextNotesTodo.actions.more');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, reveal)}
          aria-label={label}
          title={label}
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
