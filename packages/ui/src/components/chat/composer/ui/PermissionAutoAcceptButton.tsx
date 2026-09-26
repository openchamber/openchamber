/**
 * Cycles how this session answers tool permissions: ask, safety net, accept
 * everything. The safety net is left out of the cycle while no classification
 * provider can run it.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard: on
 * Android's resizes-content viewport the keyboard-close relayout moves this
 * button mid-tap and the click never lands.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    /** Already passed through `displayedPermissionMode`. */
    permissionMode: PermissionMode;
    handlePermissionModeCycle: () => void;
    withTooltip?: boolean;
};

const MODE_ICON = {
    ask: { icon: 'shield-user', color: undefined },
    safety: { icon: 'shield-star', color: 'var(--status-success)' },
    auto: { icon: 'shield-check', color: 'var(--status-info)' },
} satisfies Record<PermissionMode, { icon: IconName; color: string | undefined }>;

export const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        permissionMode,
        handlePermissionModeCycle,
        withTooltip = false,
    } = props;

    const label = permissionMode === 'safety'
        ? t('chat.chatInput.permissionMode.safety')
        : permissionMode === 'auto'
            ? t('chat.chatInput.permissionMode.auto')
            : t('chat.chatInput.permissionMode.ask');
    const { icon, color } = MODE_ICON[permissionMode];

    const button = (
        <button
            type="button"
            onClick={handlePermissionModeCycle}
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
            aria-label={label}
            title={label}
        >
            <Icon name={icon} className={cn(iconSizeClass)} style={color ? { color } : undefined} />
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
                {label}
            </TooltipContent>
        </Tooltip>
    );
});
