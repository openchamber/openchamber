import type { useI18n } from '@/lib/i18n';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerFileIntake } from './useComposerFileIntake';
import React from 'react';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

type Dependencies = {
    fileIntake: Pick<ReturnType<typeof useComposerFileIntake>, 'attachFilesWithCitation'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'vscodeApi'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
};

const openDraftId = () => {
    const { newSessionDraft } = useSessionUIStore.getState();
    return newSessionDraft.open ? newSessionDraft.draftId : null;
};

export function useComposerFilePicker({
    fileIntake, runtime, i18n,
}: Dependencies) {
    const { attachFilesWithCitation } = fileIntake;
    const { vscodeApi } = runtime;
    const { t } = i18n;

    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const cameraInputRef = React.useRef<HTMLInputElement>(null);
    const cameraTarget = React.useRef<(() => boolean) | null>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        await attachFilesWithCitation(Array.isArray(files) ? files : Array.from(files));
    }, [attachFilesWithCitation]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.({})) as {
                files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
                skipped?: Array<{ name?: string; reason?: string }>;
            } | undefined;
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, t, vscodeApi]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const handlePickCameraPhoto = React.useCallback(() => {
        const input = cameraInputRef.current;
        if (!input) return;
        const draftKey = useInputStore.getState().attachmentDraftKey;
        const draftId = openDraftId();
        const isCurrentRuntime = captureRuntimeInstance();
        cameraTarget.current = () => isCurrentRuntime()
            && useInputStore.getState().attachmentDraftKey === draftKey && openDraftId() === draftId;
        input.click();
    }, []);

    const handleCameraPhotoSelect = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const photo = input.files?.[0];
        const isCurrentTarget = cameraTarget.current;
        cameraTarget.current = null;
        input.value = '';
        if (!photo || !isCurrentTarget?.()) return;
        void attachFilesWithCitation([photo]);
    }, [attachFilesWithCitation]);

    return {
        handlePickLocalFiles, fileInputRef, handleLocalFileSelect,
        handlePickCameraPhoto, cameraInputRef, handleCameraPhotoSelect,
    };
}
