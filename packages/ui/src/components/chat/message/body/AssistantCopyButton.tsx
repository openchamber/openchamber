import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export const AssistantCopyButton = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
}: {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage: () => void | boolean | Promise<void | boolean>;
}) => {
    const { t } = useI18n();
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout, clearCopyHintTimeout]);

    React.useEffect(() => {
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const copied = await onCopyMessage();
            if (copied === false) {
                return;
            }

            clearCopiedResetTimeout();
            setIsMessageCopied(true);
            if (typeof window !== 'undefined') {
                copiedResetTimeoutRef.current = window.setTimeout(() => {
                    setIsMessageCopied(false);
                    copiedResetTimeoutRef.current = null;
                }, 2000);
            }

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [clearCopiedResetTimeout, hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                    className={cn(
                        'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                        !hasCopyableText && 'opacity-50'
                    )}
                    disabled={!hasCopyableText}
                    aria-label={t('chat.messageBody.actions.copyMessageAria')}
                    aria-hidden={!hasCopyableText}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        void handleCopyButtonClick(event);
                    }}
                    onFocus={() => {
                        if (hasCopyableText) {
                            setCopyHintVisible(true);
                        }
                    }}
                    onBlur={() => {
                        if (!isMessageCopied) {
                            setCopyHintVisible(false);
                        }
                    }}
                >
                    {isMessageCopied ? (
                        <Icon name="check" className="h-3 w-3 text-[color:var(--status-success)]" />
                    ) : (
                        <Icon name="file-copy" className="h-3 w-3" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
        </Tooltip>
    );
});
