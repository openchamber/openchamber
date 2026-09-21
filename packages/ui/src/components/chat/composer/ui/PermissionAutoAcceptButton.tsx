/**
 * Toggles whether tool permissions are auto-accepted for this session.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard: on
 * Android's resizes-content viewport the keyboard-close relayout moves this
 * button mid-tap and the click never lands.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    permissionAutoAcceptEnabled: boolean;
    handlePermissionAutoAcceptToggle: () => void;
    withTooltip?: boolean;
};

export const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        permissionAutoAcceptEnabled,
        handlePermissionAutoAcceptToggle,
        withTooltip = false,
    } = props;

    const ariaLabel = permissionAutoAcceptEnabled
        ? t('chat.chatInput.permissionAutoAccept.disable')
        : t('chat.chatInput.permissionAutoAccept.enable');
    const tooltipLabel = permissionAutoAcceptEnabled
        ? t('chat.chatInput.permissionAutoAccept.on')
        : t('chat.chatInput.permissionAutoAccept.off');

    const button = (
        <button
            type="button"
            onClick={handlePermissionAutoAcceptToggle}
            className={cn(
                footerIconButtonClass,
                'rounded-md hover:bg-transparent',
                !isInteractive && 'opacity-30',
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
            aria-pressed={permissionAutoAcceptEnabled}
            aria-label={ariaLabel}
            title={ariaLabel}
        >
            {permissionAutoAcceptEnabled ? (
                <Icon name="shield-check" className={cn(iconSizeClass)} style={{ color: 'var(--status-info)' }} />
            ) : (
                <Icon name="shield-user" className={cn(iconSizeClass)} />
            )}
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {button}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {tooltipLabel}
            </TooltipContent>
        </Tooltip>
    );
});
