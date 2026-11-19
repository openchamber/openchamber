import React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';

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
