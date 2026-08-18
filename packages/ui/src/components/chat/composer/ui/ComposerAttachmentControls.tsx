/**
 * Attachment and settings controls in the composer footer.
 *
 * Rendered twice on mobile — once in the collapsed pill, once in the expanded
 * footer — so it stays a memoized component with an explicit comparator: a
 * re-render of the whole composer must not tear down the dropdown while it is
 * open.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerAttachmentControlsProps = {
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    openIssuePicker: () => void;
    openPrPicker: () => void;
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    /** Mobile: open the attachment bottom sheet instead of the dropdown menu. */
    onOpenMobileSheet?: () => void;
};

export const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        openIssuePicker,
        openPrPicker,
        onOpenSettings,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {props.onOpenMobileSheet ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={props.onOpenMobileSheet}
                        // Same guard as PermissionAutoAcceptButton: keep the tap
                        // from dismissing the keyboard. On Android's
                        // resizes-content viewport the keyboard-close relayout
                        // moves this button mid-tap and the click never lands.
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
                ) : isVSCode ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={handlePickLocalFiles}
                        title={t('chat.chatInput.actions.attachFiles')}
                        aria-label={t('chat.chatInput.actions.attachFiles')}
                    >
                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title={t('chat.chatInput.actions.addAttachment')}
                                aria-label={t('chat.chatInput.actions.addAttachment')}
                            >
                                <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
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
                                    requestAnimationFrame(openIssuePicker);
                                }}
                            >
                                <Icon name="github"/>
                                {t('chat.chatInput.actions.linkGithubIssue')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openPrPicker);
                                }}
                            >
                                <Icon name="git-pull-request"/>
                                {t('chat.chatInput.actions.linkGithubPr')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={t('chat.chatInput.actions.modelAgentSettings')}
                    aria-label={t('chat.chatInput.actions.modelAgentSettings')}
                >
                    <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
));
