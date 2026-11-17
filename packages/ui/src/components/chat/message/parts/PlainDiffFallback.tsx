import React from 'react';

import { getToolDiffPreviewText } from './toolDiffPreview';

export const PlainDiffFallback: React.FC<{ diff: string }> = ({ diff }) => {
    const preview = React.useMemo(() => getToolDiffPreviewText(diff), [diff]);

    return (
        <pre
            className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 typography-code"
            style={{
                backgroundColor: 'var(--syntax-background)',
                color: 'var(--syntax-foreground)',
            }}
        >
            {preview}
        </pre>
    );
};
