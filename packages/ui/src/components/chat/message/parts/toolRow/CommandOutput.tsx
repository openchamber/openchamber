import React from 'react';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import { TOOL_COLLAPSED_CUSTOM_STYLE, CODE_TAG_PROPS } from './toolRowStyles';
import { CopyToolOutputButton } from './CopyToolOutputButton';

/** What a command printed, with a copy button: a shell row's output, and a secret run's. */
export const CommandOutput: React.FC<{ output: string; language: string }> = ({ output, language }) => (
    // min-h-7 holds the copy button (top-1 + h-6): an absolute child taller
    // than one output line overflows the scroller, and platforms with
    // classic scrollbars (Windows) then show one for a single line.
    <div className="relative min-h-7 typography-code text-muted-foreground">
        <div className="absolute inset-e-1 top-1 z-10">
            <CopyToolOutputButton output={output} />
        </div>
        <div className="pe-8">
            <HighlightedCode
                language={language}
                code={output}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    </div>
);
