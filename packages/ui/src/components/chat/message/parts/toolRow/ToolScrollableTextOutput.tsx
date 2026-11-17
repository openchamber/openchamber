import React from 'react';
import { SimpleMarkdownRenderer } from '../../../MarkdownRenderer';
import type { ToolPart as ToolPartType } from '@/lib/opencode/model';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import type { ToolPopupContent } from '../../types';
import { tryParseJsonOutput } from '../../toolRenderers';
import { GuestToolCard } from '../GuestToolCard';
import { GuestToolTable } from '../GuestToolTable';
import { guestToolTableRows, resolveGuestToolCard, type GuestToolRule } from '@/lib/guests/tool-presentation';
import { isShellTool } from '@/lib/opencode/tools';
import { TOOL_COLLAPSED_CUSTOM_STYLE, CODE_TAG_PROPS } from './toolRowStyles';
import { getToolOutputLanguage, getToolOutputText } from './toolOutputText';
import { StreamingPlainTextOutput } from './StreamingPlainTextOutput';
import { JsonToolOutput } from './JsonToolOutput';
import { CommandOutput } from './CommandOutput';

export const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: ToolPartType;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isStreaming?: boolean;
    presentation?: GuestToolRule | null;
    onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ output, part, metadata, input, isStreaming = false, presentation = null, onShowPopup }) => {
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const forcedMode = presentation?.output && presentation.output !== 'auto' ? presentation.output : null;
    const card = React.useMemo(
        () => (forcedMode === 'card' && presentation && jsonResult.isJson ? resolveGuestToolCard(presentation, jsonResult.data) : null),
        [forcedMode, presentation, jsonResult],
    );

    if (isShellTool(part.tool) && isStreaming) {
        return (
            <div className="typography-code text-muted-foreground">
                <StreamingPlainTextOutput output={renderedOutput} />
            </div>
        );
    }

    if (forcedMode === 'markdown') {
        return (
            <div className="w-full min-w-0">
                <SimpleMarkdownRenderer content={renderedOutput} singleTilde={false} variant="tool" onShowPopup={onShowPopup} />
            </div>
        );
    }

    if (forcedMode === 'table' && presentation?.columns?.length) {
        const rows = jsonResult.isJson ? guestToolTableRows(jsonResult.data) : null;
        if (rows) {
            return <GuestToolTable rows={rows} columns={presentation.columns} />;
        }
    }

    if (card) return <GuestToolCard result={card} />;

    if (forcedMode === 'text' || forcedMode === 'code') {
        return (
            <HighlightedCode
                language={forcedMode === 'code' && presentation?.language ? presentation.language : 'text'}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        );
    }

    if (jsonResult.isJson) {
        return <JsonToolOutput jsonResult={jsonResult} renderedOutput={renderedOutput} />;
    }

    if (isShellTool(part.tool)) return <CommandOutput output={renderedOutput} language={outputLanguage} />;

    return (
        <div>
            <HighlightedCode
                language={outputLanguage}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';
