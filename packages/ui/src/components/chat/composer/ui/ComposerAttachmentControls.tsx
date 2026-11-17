
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import type { IconName } from '@/components/icon/icons';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { GuestAttachItem } from '@/hooks/useGuestSurfaces';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type ComposerTrackerPicker = { provider: string; icon: IconName; label: string; open: () => void };

type ComposerAttachmentControlsProps = {
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    openGitHubPicker: () => void;
    repositoryProvider?: string | null;
    trackerPickers?: readonly ComposerTrackerPicker[];
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    onOpenMobileSheet?: () => void;
    attachGuests?: readonly GuestAttachItem[];
    onOpenGuestAttach?: (guestId: string) => void;
    filesOnly?: boolean;
};

export const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        openGitHubPicker,
        repositoryProvider = null,
        trackerPickers,
        onOpenSettings,
        attachGuests,
        onOpenGuestAttach,
        filesOnly = false,
    } = props;
    const repositoryDescriptor = useSourceControlProvider(repositoryProvider);

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {props.onOpenMobileSheet && !filesOnly ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={props.onOpenMobileSheet}
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        title={t('chat.chatInput.actions.addAttachment')}
                        aria-label={t('chat.chatInput.actions.addAttachment')}
                    >
                        <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : isVSCode || filesOnly ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                onClick={handlePickLocalFiles}
                                aria-label={t('chat.chatInput.actions.attachFiles')}
                            >
                                <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={8}>{t('chat.chatInput.actions.attachFiles')}</TooltipContent>
                    </Tooltip>
                ) : (
                    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex">
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className={footerIconButtonClass}
                                            aria-label={t('chat.chatInput.actions.addAttachment')}
                                        >
                                            <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                                        </button>
                                    </DropdownMenuTrigger>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8}>{t('chat.chatInput.actions.addAttachment')}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent side="top" align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <Icon name="attachment-2"/>
                                {t('chat.chatInput.actions.attachFiles')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openGitHubPicker);
                                }}
                            >
                                <ProviderIcon descriptor={repositoryDescriptor}/>
                                {t(`chat.chatInput.actions.linkRepositoryItem.${repositoryDescriptor.terminology.changeRequest}`, { provider: repositoryDescriptor.label })}
                            </DropdownMenuItem>
                            {trackerPickers?.map((picker) => (
                                <DropdownMenuItem
                                    key={picker.provider}
                                    onSelect={() => {
                                        requestAnimationFrame(picker.open);
                                    }}
                                >
                                    <Icon name={picker.icon}/>
                                    {picker.label}
                                </DropdownMenuItem>
                            ))}
                            {attachGuests?.map((guest) => (
                                <DropdownMenuItem
                                    key={guest.id}
                                    onSelect={() => {
                                        requestAnimationFrame(() => onOpenGuestAttach?.(guest.id));
                                    }}
                                >
                                    <GuestIcon icon={guest.icon} iconSrc={guest.iconSrc} className="size-4" />
                                    {guest.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {onOpenSettings ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={onOpenSettings}
                            className={footerIconButtonClass}
                            aria-label={t('chat.chatInput.actions.modelAgentSettings')}
                        >
                            <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8}>{t('chat.chatInput.actions.modelAgentSettings')}</TooltipContent>
                </Tooltip>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.trackerPickers === next.trackerPickers
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
    && prev.onOpenGuestAttach === next.onOpenGuestAttach
    && prev.filesOnly === next.filesOnly
    && prev.repositoryProvider === next.repositoryProvider
    && (prev.attachGuests ?? []).map((guest) => `${guest.id}:${guest.name}:${guest.mode}`).join()
        === (next.attachGuests ?? []).map((guest) => `${guest.id}:${guest.name}:${guest.mode}`).join()
));
