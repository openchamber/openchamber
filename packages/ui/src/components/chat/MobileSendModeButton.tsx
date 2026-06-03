import React from 'react';

import { ListStartIcon } from '@/components/icons/ListStartIcon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type SendMessageMode = 'queue' | 'steer';

type MobileSendModeButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendMode: SendMessageMode;
    onToggle: () => void;
};

export const MobileSendModeButton = React.memo(function MobileSendModeButton(props: MobileSendModeButtonProps) {
    const { footerIconButtonClass, iconSizeClass, sendMode, onToggle } = props;
    const { t } = useI18n();
    const isQueueMode = sendMode === 'queue';
    const ariaLabel = isQueueMode
        ? t('chat.chatInput.sendMode.switchToSteer')
        : t('chat.chatInput.sendMode.switchToQueue');
    const title = isQueueMode
        ? t('chat.chatInput.sendMode.queue')
        : t('chat.chatInput.sendMode.steer');

    return (
        <button
            type="button"
            onClick={onToggle}
            className={cn(
                footerIconButtonClass,
                'rounded-md hover:bg-transparent',
                isQueueMode ? 'text-[var(--status-info)]' : 'text-foreground',
            )}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-pressed={isQueueMode}
            aria-label={ariaLabel}
            title={title}
        >
            <ListStartIcon className={cn(iconSizeClass, 'scale-90')} aria-hidden="true" />
        </button>
    );
});

export default MobileSendModeButton;
