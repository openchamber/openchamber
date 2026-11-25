import React from 'react';

import type { ChatQuoteExcerpt } from '@/lib/messages/quoteDisplayText';

export const ChatQuoteBody: React.FC<{ excerpt: ChatQuoteExcerpt }> = ({ excerpt }) => {
    if (!excerpt.hasContext) return <>{excerpt.quote}</>;
    return (
        <>
            {excerpt.prefix || null}
            <mark className="rounded-sm bg-foreground/12 px-0.5 text-foreground box-decoration-clone">
                {excerpt.quote}
            </mark>
            {excerpt.suffix || null}
        </>
    );
};
