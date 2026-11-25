import React from 'react';

import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';

type ImagePreviewActionsProps = {
    canAnnotate: boolean;
    annotating: boolean;
    canStartAnnotate: boolean;
    canDownload: boolean;
    onStartAnnotate: () => void;
    onCancelAnnotate: () => void;
    onClose: () => void;
    onDownload: () => void;
};

export const ImagePreviewActions: React.FC<ImagePreviewActionsProps> = ({
    canAnnotate,
    annotating,
    canStartAnnotate,
    canDownload,
    onStartAnnotate,
    onCancelAnnotate,
    onClose,
    onDownload,
}) => {
    const { t } = useI18n();
    return (
        <div className="flex shrink-0 items-center gap-0.5">
            {canAnnotate && !annotating ? (
                <ToolbarTooltipButton
                    label={t('chat.image.annotate.action')}
                    icon="pencil"
                    onClick={onStartAnnotate}
                    disabled={!canStartAnnotate}
                />
            ) : null}
            {!annotating && canDownload ? (
                <ToolbarTooltipButton label={t('chat.image.download')} icon="download" onClick={onDownload} />
            ) : null}
            <ToolbarTooltipButton
                label={annotating
                    ? t('chat.image.annotate.cancel')
                    : t('chat.toolOutputDialog.image.closeAria')}
                icon="close"
                onClick={annotating ? onCancelAnnotate : onClose}
            />
        </div>
    );
};