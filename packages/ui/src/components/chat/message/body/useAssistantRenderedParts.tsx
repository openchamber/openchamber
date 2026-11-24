import React from 'react';
import type { Part, ToolPart as ToolPartType } from '@/lib/opencode/model';
import type { StreamPhase, ToolPopupContent } from '../types';
import type { TurnGroupingContext } from '../../lib/turns/types';
import ToolPart from '../parts/ToolPart';
import AssistantTextPart from '../parts/AssistantTextPart';
import ReasoningPart from '../parts/ReasoningPart';
import { isEmptyTextPart } from '../partUtils';
import { isInvisibleText } from '@/lib/invisibleText';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { SessionNoticeBlock } from '../SessionNoticeBlock';
import { readSessionNoticePart } from '@/lib/opencode/session-notices';
import { StaticToolRow } from '../parts/ProgressiveGroup';
import { isExpandableTool } from '../parts/toolRenderUtils';
import { ShownPartCard, ShownToolCard } from '../parts/ShownToolCard';
import { isShownInPlace } from '@/lib/opencode/tools';
import { LiveActivityCollapse } from '../../components/LiveActivityCollapse';
import { ActivityRowSkipContext, isActivityRowPart, isToolRowShown } from '../../lib/turns/activityRows';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext } from '../../components/liveActivityContext';
import { MessageSliceContext } from '../messageSliceContext';
import { MessageSelectionMark } from '../../messageSelection/MessageSelectionMark';
import { useUIStore } from '@/stores/useUIStore';
import { INLINE_MESSAGE_ACTIONS_CLASS_NAME } from './messageBodyStyles';

export const useAssistantRenderedParts = ({
    messageId,
    sessionId,
    visibleParts,
    messageTextContentRef,
    messageActionButtons,
    answerSelectionKey,
    effectiveStreamPhase,
    hasStopFinish,
    isLastAssistantInTurn,
    turnGroupingContext,
    showReasoningTraces,
    expandedTools,
    onToggleTool,
    onShowPopup,
    isMobile,
    alwaysShowMessageActions,
    shouldShowStandaloneMessageActions,
    lastRenderableTextPartIndex,
}: {
    messageId: string;
    sessionId: string | undefined;
    visibleParts: Part[];
    messageTextContentRef: React.RefObject<HTMLDivElement | null>;
    messageActionButtons: React.ReactNode;
    answerSelectionKey: string | null;
    effectiveStreamPhase: StreamPhase;
    hasStopFinish: boolean;
    isLastAssistantInTurn: boolean;
    turnGroupingContext: TurnGroupingContext | undefined;
    showReasoningTraces: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    isMobile: boolean;
    alwaysShowMessageActions: boolean;
    shouldShowStandaloneMessageActions: boolean;
    lastRenderableTextPartIndex: number;
}) => {
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const liveFinalActivity = React.useContext(LiveFinalActivityContext);
    const activityRowSkip = React.useContext(ActivityRowSkipContext);
    const hoistedPages = React.useContext(LiveTurnHoistedPagesContext);
    const slice = React.useContext(MessageSliceContext);

    return React.useMemo(() => {
        const answerRendered: React.ReactNode[] = [];
        const activityRendered: React.ReactNode[] = [];
        let rendered = answerRendered;
        const splitLiveActivity = liveFinalActivity?.messageId === messageId && hasStopFinish;
        let hasRenderedAnswerText = false;
        const isFinalLiveAnswer = isLastAssistantInTurn && hasStopFinish;
        const hasEarlierVisibleActivity = isFinalLiveAnswer && Boolean(turnGroupingContext?.activityParts?.some((activity) => {
            if (activity.messageId === messageId) {
                return false;
            }
            if (activity.part.type === 'tool') {
                return isToolRowShown(activity.part);
            }
            return showReasoningTraces && !isEmptyTextPart(activity.part);
        }));

        let rowsToSkip = activityRowSkip?.messageId === messageId ? activityRowSkip.rows : 0;
        let sliceStarted = !slice?.from;
        const firstTextPartId = visibleParts.find((candidate) => candidate.type === 'text')?.id;
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];
            if (!sliceStarted) {
                sliceStarted = part.id === slice?.from?.partId;
                if (!sliceStarted) {
                    i += 1;
                    continue;
                }
            }
            if (slice?.to && (slice.to.offset === 0 ? part.id === slice.to.partId : visibleParts[i - 1]?.id === slice.to.partId)) break;
            if (rowsToSkip > 0 && isActivityRowPart(part) && !hoistedPages?.has(part.id)) {
                rowsToSkip -= 1;
                i += 1;
                continue;
            }
            rendered = splitLiveActivity && part.type !== 'text' ? activityRendered : answerRendered;

            if (part.type === 'text') {
                if (part.id && hoistedPages?.has(part.id)) {
                    i++;
                    continue;
                }
                const textStart = slice?.from?.partId === part.id ? slice.from.offset : 0;
                const textEnd = slice?.to?.partId === part.id && slice.to.offset > 0 ? slice.to.offset : undefined;
                if (textStart > 0 || (slice?.from && part.id !== firstTextPartId)) {
                    hasRenderedAnswerText = true;
                }
                const divider = !hasRenderedAnswerText && isFinalLiveAnswer && (rendered.length > 0 || activityRendered.length > 0 || hasEarlierVisibleActivity || turnGroupingContext?.earlierAssistantText) ? (
                    <div
                        key={`final-answer-divider-${messageId}`}
                        aria-hidden="true"
                        className="mt-1.5 mb-3 h-px w-full bg-muted-foreground/20"
                    />
                ) : null;
                const pages = splitLiveActivity && !hasRenderedAnswerText && textStart === 0
                    ? (liveFinalActivity?.pages ?? []).map((pagePart) => <ShownPartCard key={`page-${pagePart.id}`} part={pagePart} onShowPopup={onShowPopup} />)
                    : [];
                const lead = liveFinalActivity?.keepText ? [...pages, divider] : [divider, ...pages];
                for (const node of lead) if (node) rendered.push(node);
                hasRenderedAnswerText = true;
                rendered.push(
                    <div
                        key={`assistant-text-${messageId}-${i}`}
                        ref={messageTextContentRef}
                        data-message-text-export-source="true"
                        data-message-select-unit={answerSelectionKey ?? undefined}
                    >
                        <MessageSelectionMark
                            sessionId={sessionId}
                            unitKey={answerSelectionKey}
                            kind="answer"
                            showCheckbox={Boolean(turnGroupingContext?.opensAnswerText) && part.id === firstTextPartId && textStart === 0}
                        />
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={effectiveStreamPhase}
                            onShowPopup={onShowPopup}
                            range={textStart > 0 || textEnd !== undefined ? { start: textStart, end: textEnd } : undefined}
                        />
                    </div>
                );
                if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className="flex items-center gap-1.5" data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'reasoning') {
                const reasoningEnded = part.time?.end !== undefined
                    || (effectiveStreamPhase !== 'streaming' && effectiveStreamPhase !== 'cooldown');
                if (showReasoningTraces && !(reasoningEnded && isInvisibleText(part.text))) {
                    if (!collapsibleThinkingBlocks) {
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                onShowPopup={onShowPopup}
                            />
                        );
                    } else {
                        rendered.push(
                            <ReasoningPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                            />
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                const notice = readSessionNoticePart(toolPart);
                if (notice) {
                    rendered.push(
                        <FadeInOnReveal key={`notice-${toolPart.id}`}>
                            <SessionNoticeBlock notice={notice} blockId={toolPart.id} />
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                if (!isToolRowShown(toolPart)) {
                    i++;
                    continue;
                }

                if (isShownInPlace(toolPart.tool, toolPart.state)) {
                    if (!hoistedPages?.has(toolPart.id)) {
                        rendered.push(<ShownToolCard key={`page-${toolPart.id}`} part={toolPart} onShowPopup={onShowPopup} />);
                    }
                    i++;
                    continue;
                }

                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolPart
                                part={toolPart}
                                isExpanded={expandedTools.has(toolPart.id)}
                                onToggle={onToggleTool}
                                isMobile={isMobile}
                                alwaysShowActions={alwaysShowMessageActions}
                                onShowPopup={onShowPopup}
                                animateTailText={false}
                            />
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                rendered.push(
                    <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
                        <StaticToolRow
                            toolName={toolName}
                            activities={[
                                {
                                    id: toolPart.id,
                                    turnId: '',
                                    messageId,
                                    partIndex: 0,
                                    part: toolPart,
                                    kind: 'tool' as const,
                                },
                            ]}
                            animateTailText={false}
                        />
                    </FadeInOnReveal>
                );
                i++;
                continue;
            }

            i++;
        }

        if (splitLiveActivity && liveFinalActivity && (!slice?.from || activityRendered.length > 0)) {
            return [
                <LiveActivityCollapse key="final-message-activity" expanded={liveFinalActivity.expanded}
                    id={slice?.from ? undefined : liveFinalActivity.contentId}>
                    {activityRendered}
                </LiveActivityCollapse>,
                ...answerRendered,
            ];
        }
        return answerRendered;
    }, [
        activityRowSkip,
        alwaysShowMessageActions,
        hoistedPages,
        collapsibleThinkingBlocks,
        expandedTools,
        isMobile,
        liveFinalActivity,
        isLastAssistantInTurn,
        hasStopFinish,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        messageTextContentRef,
        sessionId,
        onShowPopup,
        onToggleTool,
        shouldShowStandaloneMessageActions,
        effectiveStreamPhase,
        showReasoningTraces,
        slice,
        turnGroupingContext,
        visibleParts,
        answerSelectionKey,
    ]);
};
