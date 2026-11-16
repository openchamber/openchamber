import React from 'react';
import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { useI18n } from '@/lib/i18n';
import { isShellTool, isSubagentTool, normalizeToolName } from '@/lib/opencode/tools';
import type { ToolPartProps } from './toolRow/types';
import { toolDisplayName } from './toolRow/toolDescriptions';
import { ToolPartContent } from './toolRow/ToolPartContent';
import { ToolPartErrorBoundary } from './toolRow/ToolPartErrorBoundary';
import { BackgroundShellToolPartContent } from './toolRow/BackgroundShellToolPartContent';
import { ShellToolPartContent } from './toolRow/ShellToolPartContent';
import { SubagentToolPartContent } from './toolRow/SubagentToolPartContent';
import { useShownToolPart } from './toolRow/useShownToolPart';

const ToolPart: React.FC<ToolPartProps> = (incoming) => {
    const { t } = useI18n();
    const part = useShownToolPart(incoming.part);
    const props = part === incoming.part ? incoming : { ...incoming, part };
    const toolName = normalizeToolName(props.part.tool) || 'tool';
    const displayName = toolDisplayName(toolName, t);
    const backgroundShellID = isShellTool(toolName) ? readBackgroundShellID(props.part) : undefined;

    return (
        <ToolPartErrorBoundary
            displayName={displayName}
            errorLabel={t('chat.toolPart.error')}
            resetKey={props.part}
            toolName={toolName}
        >
            {backgroundShellID
                ? <BackgroundShellToolPartContent {...props} shellID={backgroundShellID} />
                : isSubagentTool(toolName)
                    ? <SubagentToolPartContent {...props} />
                    : isShellTool(toolName)
                        ? <ShellToolPartContent {...props} />
                        : <ToolPartContent {...props} />}
        </ToolPartErrorBoundary>
    );
};

export default React.memo(ToolPart, (prev, next) => {
    return areRenderRelevantPartsEqual([prev.part], [next.part])
        && prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.alwaysShowActions === next.alwaysShowActions
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText
        && prev.failureReason === next.failureReason;
});
