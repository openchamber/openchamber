import React from 'react';
import { useUIStore } from '@/stores/useUIStore';

export const useChatWidthAttribute = (): void => {
  const chatWidth = useUIStore((state) => state.chatWidth);
  React.useEffect(() => {
    const root = document.documentElement;
    if (chatWidth === 'default') {
      root.removeAttribute('data-chat-width');
      return;
    }
    root.setAttribute('data-chat-width', chatWidth);
    return () => root.removeAttribute('data-chat-width');
  }, [chatWidth]);
};
