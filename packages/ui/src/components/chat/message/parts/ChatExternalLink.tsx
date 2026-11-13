import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

import { useOpenChatLink } from '../../useOpenChatLink';

/**
 * A web address a tool part shows, outside markdown. A plain click goes where
 * a link in the text goes (`useOpenChatLink`), so the link settings apply;
 * modified clicks keep the browser's own meaning.
 */
export const ChatExternalLink: React.FC<React.ComponentProps<'a'> & { href: string }> = ({ href, children, ...props }) => {
    const openChatLink = useOpenChatLink(useEffectiveDirectory() ?? '');
    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        openChatLink(href);
    };
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>{children}</a>;
};
