import React from 'react';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import { TOOL_COLLAPSED_CUSTOM_STYLE, CODE_TAG_PROPS } from './toolRowStyles';
import { CopyToolOutputButton } from './CopyToolOutputButton';

export const CommandOutput: React.FC<{ output: string; language: string }> = ({ output, language }) => (
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
