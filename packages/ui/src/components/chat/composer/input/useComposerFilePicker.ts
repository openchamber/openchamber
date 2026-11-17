import React from 'react';
import { ACCEPTED_ATTACHMENT_EXTENSIONS } from '@/sync/attachment-files';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { useComposerFileIntake } from './useComposerFileIntake';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerInputState } from './useComposerInputState';

type Dependencies = Pick<ReturnType<typeof useComposerFileIntake>, 'attachFilesWithCitation'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'vscodeApi'>
    & Pick<ReturnType<typeof useComposerInputState>, 't'>;

export function useComposerFilePicker({
    attachFilesWithCitation, vscodeApi, t,
}: Dependencies) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Files picked from the attach menu (or VS Code's picker) land as chips at
    // the caret, as pasted and dropped ones do.
    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        await attachFilesWithCitation(Array.isArray(files) ? files : Array.from(files));
    }, [attachFilesWithCitation]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.({ extensions: ACCEPTED_ATTACHMENT_EXTENSIONS })) as {
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

    return {
        handlePickLocalFiles, fileInputRef, handleLocalFileSelect,
    };
}
