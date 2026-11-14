import React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';

/**
 * A long press on a mobile row opens its menu, as a right click does on the
 * desktop row. The swipe keeps the quick actions; the menu carries the rest.
 * The click the finger's release sends would open the row, so it is dropped
 * once a press opened the menu.
 */
export const MobileRowMenu: React.FC<{
  disabled?: boolean;
  menu: React.ReactNode;
  children: React.ReactNode;
}> = ({ disabled = false, menu, children }) => {
  const openedByPress = React.useRef(false);
  return (
    <ContextMenu
      disabled={disabled}
      onOpenChange={(open, details) => {
        // Only a finger's press is followed by a click; a right click or the
        // keyboard opens the menu without one.
        openedByPress.current = open && details.event.type.startsWith('touch');
      }}
    >
      <ContextMenuTrigger
        render={<div />}
        onTouchStart={() => { openedByPress.current = false; }}
        onClickCapture={(event) => {
          if (!openedByPress.current) return;
          openedByPress.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
};
