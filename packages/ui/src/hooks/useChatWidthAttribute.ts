import React from 'react';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Puts the chat width setting on the document root as `data-chat-width`, where
 * the chat column rules in `styles/typography.css` read it. Default leaves the
 * attribute off.
 */
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
