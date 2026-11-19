import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useI18n } from '@/lib/i18n';
import React from 'react';
import { getUnsupportedAttachmentInputs, type AttachmentInputModality } from '@/sync/attachment-files';
import { toast } from '@/components/ui';


type Dependencies = {
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'currentModelMetadata'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'attachedFiles'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
};

export function useComposerAttachmentCompatibility({
    selection, sessionScope, i18n,
}: Dependencies) {
    const { currentProviderId, currentModelId, currentModelMetadata } = selection;
    const { attachedFiles } = sessionScope;
    const { t } = i18n;

    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const unsupported = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        const summarize = (filenames: string[]) => (filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', '));
        const modelName = currentModelMetadata.name ?? currentModelId ?? '';

        const images = unsupported.filter(({ modality }) => modality === 'image');
        if (images.length > 0) {
            toast.info(t('chat.chatInput.toast.imagesSentAsPathsForTextModel', {
                model: modelName,
                files: summarize(images.map(({ attachment }) => attachment.filename)),
            }), { id: `image-paths:${modelKey}` });
        }

        const incompatibleFiles = unsupported.filter(({ modality }) => modality !== 'image');
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: t('chat.modelControls.modality.text'),
            image: t('chat.modelControls.modality.image'),
            pdf: t('chat.modelControls.modality.pdf'),
            audio: t('chat.modelControls.modality.audio'),
            video: t('chat.modelControls.modality.video'),
        };
        toast.warning(t('chat.chatInput.toast.unsupportedAttachmentModalities', {
            model: modelName,
            modalities: unsupportedModalities.map((modality) => modalityLabels[modality]).join(', '),
            files: summarize(incompatibleFiles.map(({ attachment }) => attachment.filename)),
        }), { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId, t]);
}
