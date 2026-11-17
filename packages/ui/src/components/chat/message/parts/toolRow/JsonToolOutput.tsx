import React from 'react';
import { cn } from '@/lib/utils';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { tryParseJsonOutput, unwrapTextBlocks } from '../../toolRenderers';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { JsonSummaryView } from '../JsonSummaryView';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import type { ToolJsonViewMode } from './types';
import { TOOL_COLLAPSED_CUSTOM_STYLE, CODE_TAG_PROPS } from './toolRowStyles';
import { CopyToolOutputButton } from './CopyToolOutputButton';

type JsonOutputResult = ReturnType<typeof tryParseJsonOutput>;

export const JsonToolOutput: React.FC<{
    jsonResult: JsonOutputResult;
    renderedOutput: string;
}> = ({ jsonResult, renderedOutput }) => {
    const { t } = useI18n();
    const jsonViewMode = useUIStore((state) => state.toolJsonViewMode);

    const handleJsonViewChange = React.useCallback((view: ToolJsonViewMode, event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        useUIStore.getState().setToolJsonViewMode(view);
    }, []);

    const textOutput = jsonViewMode === 'summary' ? unwrapTextBlocks(jsonResult.data) : null;

    return (
        <div className="relative w-full min-w-0">
            <div className="absolute inset-e-0 top-0 z-10 flex items-center gap-1">
                <HoverTooltip label={t('chat.toolPart.showNavigableJson')}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('summary', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showNavigableJson')}
                    >
                        <Icon name="list-unordered" className="h-3.5 w-3.5" />
                    </Button>
                </HoverTooltip>
                <HoverTooltip label={t('chat.toolPart.showFormattedJson')}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('formatted', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showFormattedJson')}
                    >
                        <Icon name="node-tree" className="h-3.5 w-3.5" />
                    </Button>
                </HoverTooltip>
                <HoverTooltip label={t('chat.toolPart.showRawJson')}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('raw', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showRawJson')}
                    >
                        <Icon name="code-box" className="h-3.5 w-3.5" />
                    </Button>
                </HoverTooltip>
                <CopyToolOutputButton output={renderedOutput} />
            </div>
            {jsonViewMode === 'summary' ? (
                textOutput !== null ? (
                    <div className="typography-code pe-12 text-muted-foreground">
                        <HighlightedCode
                            language="text"
                            code={textOutput}
                            style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            codeStyle={CODE_TAG_PROPS.style}
                            wrap
                        />
                    </div>
                ) : (
                    <JsonSummaryView data={jsonResult.data} />
                )
            ) : jsonViewMode === 'formatted' ? (
                <JsonTreeViewer
                    data={jsonResult.data}
                    initiallyExpandedDepth={1}
                    maxHeight="400px"
                />
            ) : (
                <div className="typography-code pe-12 text-muted-foreground">
                    <HighlightedCode
                        language="json"
                        code={renderedOutput}
                        style={TOOL_COLLAPSED_CUSTOM_STYLE}
                        codeStyle={CODE_TAG_PROPS.style}
                        wrap
                    />
                </div>
            )}
        </div>
    );
};
