import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type ComposerAttachmentControlsProps = {
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    handleLocalFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    handlePickLocalFiles: () => void;
    openIssuePicker: () => void;
    openPrPicker: () => void;
    onOpenSettings?: () => void;
};

export const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        fileInputRef,
        handleLocalFileSelect,
        handlePickLocalFiles,
        openIssuePicker,
        openPrPicker,
        onOpenSettings,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleLocalFileSelect}
                accept="*/*"
            />

            <div className="relative inline-flex">
                {isVSCode ? (
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
                    <DropdownMenu>
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
                                <Icon name="attachment-2" />
                                {t('chat.chatInput.actions.attachFiles')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openIssuePicker);
                                }}
                            >
                                <Icon name="github" />
                                {t('chat.chatInput.actions.linkGithubIssue')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openPrPicker);
                                }}
                            >
                                <Icon name="git-pull-request" />
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
));
