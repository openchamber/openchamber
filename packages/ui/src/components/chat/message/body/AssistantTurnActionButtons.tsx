import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { AskOtherModelsDialog } from '@/components/multirun/AskOtherModelsDialog';
import type { Session } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { AssistantCopyButton } from './AssistantCopyButton';
import type { FooterSheetAction } from './useFooterSheetActions';

export const AssistantTurnActionButtons = ({
    onCopyFooter,
    hasCopyableText,
    isTouchContext,
    isFooterTTSPlaying,
    stopFooterTTS,
    isMiniChatSurface,
    isReviewSessionView,
    handleForkFromHere,
    handleForkClick,
    canShowMultiRunAction,
    turnId,
    handleAskOtherModels,
    handleForkMultiRun,
    onToggleContextPin,
    contextPinned,
    contextPinPending,
    footerMenuActions,
    askOtherModelsSession,
    setAskOtherModelsSession,
}: {
    onCopyFooter: (() => void | boolean | Promise<void | boolean>) | undefined;
    hasCopyableText: boolean;
    isTouchContext: boolean;
    isFooterTTSPlaying: boolean;
    stopFooterTTS: () => void;
    isMiniChatSurface: boolean;
    isReviewSessionView: boolean;
    handleForkFromHere: () => void;
    handleForkClick: () => void;
    canShowMultiRunAction: boolean;
    turnId: string | undefined;
    handleAskOtherModels: () => void;
    handleForkMultiRun: () => void;
    onToggleContextPin: (() => void) | undefined;
    contextPinned: boolean | undefined;
    contextPinPending: boolean | undefined;
    footerMenuActions: FooterSheetAction[];
    askOtherModelsSession: Session | null;
    setAskOtherModelsSession: (session: Session | null) => void;
}) => {
    const { t } = useI18n();
    return (
        <>
            {onCopyFooter ? (
                <AssistantCopyButton hasCopyableText={hasCopyableText} isTouchContext={isTouchContext} onCopyMessage={onCopyFooter} />
            ) : null}
            {/* Reading starts from the "more" menu; stopping it should not mean
                hunting for it there again. */}
            {isFooterTTSPlaying ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-[var(--primary-text)] bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('chat.messageBody.tts.stopSpeaking')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); stopFooterTTS(); }}
                        >
                            <Icon name="volume-up" className="h-3 w-3 text-[var(--primary-text)]" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.tts.stopSpeaking')}</TooltipContent>
                </Tooltip>
            ) : null}
            {!isMiniChatSurface && !isReviewSessionView ? (
                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.branchMenu')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                >
                                    {/* Carry on from here, in this session or another: the
                                        branch glyph stays on Fork, one of the menu's items. */}
                                    <Icon name="chat-forward" className="h-3 w-3" />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.branchMenu')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                        <DropdownMenuItem className="typography-meta" onSelect={handleForkFromHere}>
                            <Icon name="git-branch" className="h-3.5 w-3.5" />
                            {t('chat.messageBody.actions.fork')}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleForkClick()}>
                            <Icon name="chat-new" className="h-3.5 w-3.5" />
                            {t('chat.messageBody.actions.startNewSession')}
                        </DropdownMenuItem>
                        {canShowMultiRunAction && turnId ? (
                            <DropdownMenuItem className="typography-meta" onSelect={handleAskOtherModels}>
                                <ArrowsMerge className="h-3.5 w-3.5" />
                                {t('chat.messageBody.actions.askOtherModels')}
                            </DropdownMenuItem>
                        ) : null}
                        {canShowMultiRunAction ? (
                            <DropdownMenuItem className="typography-meta" onSelect={handleForkMultiRun}>
                                <ArrowsMerge className="h-3.5 w-3.5" />
                                {t('chat.messageBody.actions.startNewMultiRun')}
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            {onToggleContextPin && hasCopyableText ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-6 w-6 bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                            )}
                            disabled={contextPinPending}
                            aria-pressed={contextPinned}
                            aria-label={t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); onToggleContextPin(); }}
                        >
                            <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3 w-3" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}</TooltipContent>
                </Tooltip>
            ) : null}
            {footerMenuActions.length > 0 ? (
                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.moreActions')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                >
                                    <Icon name="more" className="h-3 w-3" />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.moreActions')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                        {footerMenuActions.map((action) => (
                            <DropdownMenuItem
                                key={action.id}
                                className="typography-meta"
                                disabled={action.disabled}
                                onSelect={() => action.onSelect()}
                            >
                                <span className="flex size-4 shrink-0 items-center justify-center">{action.icon}</span>
                                {action.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            {askOtherModelsSession && turnId ? (
                <AskOtherModelsDialog
                    session={askOtherModelsSession}
                    turnUserMessageId={turnId}
                    open
                    onOpenChange={(open) => { if (!open) setAskOtherModelsSession(null); }}
                />
            ) : null}
        </>
    );
};
