import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { TurnGroupingContext } from '../../lib/turns/types';
import { useI18n } from '@/lib/i18n';
import { AgentModelIcon } from './AgentModelIcon';
import { MESSAGE_FOOTER_CONTAINER_STYLE } from './messageBodyStyles';
import { TurnChangedFilePills } from './TurnChangedFilePills';
import type { FooterSheetAction } from './useFooterSheetActions';

export const AssistantTurnFooter = ({
    footerFactsRef,
    footerModelName,
    footerProviderID,
    footerAgentName,
    footerEffortLabel,
    turnDurationText,
    footerTimestamp,
    alwaysShowMessageActions,
    isTouchContext,
    actionSheetOpen,
    setActionSheetOpen,
    actionButtons,
    isMiniChatSurface,
    isLastAssistantInTurn,
    hasStopFinish,
    turnGroupingContext,
    footerSheetActions,
}: {
    footerFactsRef: React.RefObject<HTMLDivElement | null>;
    footerModelName: string | undefined;
    footerProviderID: string | null | undefined;
    footerAgentName: string | undefined;
    footerEffortLabel: string | null;
    turnDurationText: string | undefined;
    footerTimestamp: string | null;
    alwaysShowMessageActions: boolean;
    isTouchContext: boolean;
    actionSheetOpen: boolean;
    setActionSheetOpen: (open: boolean) => void;
    actionButtons: React.ReactNode;
    isMiniChatSurface: boolean;
    isLastAssistantInTurn: boolean;
    hasStopFinish: boolean;
    turnGroupingContext: TurnGroupingContext | undefined;
    footerSheetActions: FooterSheetAction[];
}) => {
    const { t } = useI18n();
    return (
                    <div
                        data-message-footer=""
                        className="mt-2 mb-1 flex flex-col gap-y-1.5"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                      <div className="flex items-center gap-3">
                        <div ref={footerFactsRef} className="message-footer__facts whitespace-nowrap typography-meta text-muted-foreground">
                            {footerModelName ? (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span className="flex min-w-0 shrink items-center gap-1.5">
                                            {footerProviderID ? (
                                                <ProviderLogo
                                                    providerId={footerProviderID}
                                                    alt=""
                                                    fallback={<AgentModelIcon agentName={footerAgentName} />}
                                                    tint
                                                    className="h-[13px] w-[13px] flex-shrink-0 text-muted-foreground [&:is(img)]:grayscale [&:is(img)]:opacity-60"
                                                />
                                            ) : (
                                                <AgentModelIcon agentName={footerAgentName} />
                                            )}
                                            <span data-fact-model className="truncate">{footerModelName}</span>
                                        </span>
                                    </TooltipTrigger>
                                    {footerEffortLabel ? (
                                        <TooltipContent sideOffset={6}>
                                            {t('chat.messageBody.footer.reasoningTooltip', { effort: footerEffortLabel })}
                                        </TooltipContent>
                                    ) : null}
                                </Tooltip>
                            ) : null}
                            {footerAgentName ? (
                                <span data-fact-priority="1" className="message-footer__fact">
                                    <span className="opacity-60" aria-hidden>·</span>
                                    {footerAgentName}
                                </span>
                            ) : null}
                            {turnDurationText ? (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span className="message-footer__fact tabular-nums">
                                            {footerModelName || footerAgentName ? <span className="opacity-60" aria-hidden>·</span> : null}
                                            {turnDurationText}
                                        </span>
                                    </TooltipTrigger>
                                    {footerTimestamp ? <TooltipContent sideOffset={6}>{footerTimestamp}</TooltipContent> : null}
                                </Tooltip>
                            ) : null}
                        </div>
                        {alwaysShowMessageActions || isTouchContext ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={t('chat.messageBody.actions.moreActions')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setActionSheetOpen(true);
                                }}
                                data-message-action-group="true"
                            >
                                <Icon name="more" className="h-3.5 w-3.5" />
                            </Button>
                        ) : (
                            <div
                                className="flex shrink-0 items-center gap-1.5 pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100 [&_button]:!h-[26px] [&_button]:!w-[26px] [&_svg]:!size-[13px]"
                                data-message-action-group="true"
                            >
                                {actionButtons}
                            </div>
                        )}
                      </div>
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <TurnChangedFilePills
                                    files={turnGroupingContext?.changedFiles}
                                    isInteractive={turnGroupingContext?.isLatestTurn === true}
                                />
                            </div>
                        ) : null}
                        <MobileOverlayPanel
                            open={actionSheetOpen}
                            onClose={() => setActionSheetOpen(false)}
                            title={t('chat.messageBody.actions.moreActions')}
                        >
                            {footerTimestamp ? (
                                <div className="mb-1 flex items-center gap-2.5 border-b border-edge-muted px-2 pb-2 typography-meta text-muted-foreground">
                                    <Icon name="time" className="size-4" />
                                    <span>{footerTimestamp}</span>
                                </div>
                            ) : null}
                            {footerSheetActions.map((action) => (
                                <MobileSheetRow
                                    key={action.id}
                                    disabled={action.disabled}
                                    leading={<span className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">{action.icon}</span>}
                                    onClick={() => {
                                        setActionSheetOpen(false);
                                        action.onSelect();
                                    }}
                                >
                                    {action.label}
                                </MobileSheetRow>
                            ))}
                        </MobileOverlayPanel>
                    </div>
    );
};
