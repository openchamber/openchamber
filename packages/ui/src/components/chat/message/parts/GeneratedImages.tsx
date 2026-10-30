import React from 'react';

import { toast } from '@/components/ui';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import { loadMessageImageBlob } from '../../markdown/markdownImageAssets';
import { MarkdownContent } from '../../MarkdownRenderer';
import type { ToolPopupContent } from '../types';
import { generatedImageDestination } from './generatedImageDestination';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { saveFile } from './saveFile';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('../ToolOutputDialog'));

/**
 * The images an `image.generate` call saved, drawn where its row would be.
 * They go through the chat's Markdown media, as if the agent had written
 * `![](path)`: the same lazy loading, size checks and full-screen gallery. The
 * image grant route allows these paths because the call's own result names
 * them (`packages/web/server/lib/markdown-image-grants/routes.js`).
 *
 * Each image has its own block, so its download sits above it; the gallery
 * still pages through all of them, since it gathers a message's images
 * wherever they are drawn.
 *
 * Inside a message the message's own viewer opens them. Above a turn that is
 * still working there is no message yet, so the card keeps a viewer of its own.
 */
export function GeneratedImages({ part, paths, onShowPopup }: {
    part: ToolPart;
    paths: readonly string[];
    onShowPopup?: (content: ToolPopupContent) => void;
}) {
    const directory = useEffectiveDirectory() ?? '';
    const { isMobile } = useDeviceInfo();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const [popup, setPopup] = React.useState<ToolPopupContent>({ open: false, title: '', content: '' });
    const ownPopup = !onShowPopup;
    const showPopup = React.useCallback((content: ToolPopupContent) => {
        setPopup(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);
    const handlePopupChange = React.useCallback((open: boolean) => {
        setPopup((previous) => ({ ...previous, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);
    return (
        <div className="my-2" data-generated-images="">
            {paths.map((path) => (
                <GeneratedImage
                    key={path}
                    part={part}
                    path={path}
                    directory={directory}
                    onShowPopup={onShowPopup ?? showPopup}
                />
            ))}
            {ownPopup && popup.open ? (
                <React.Suspense fallback={null}>
                    <ToolOutputDialog popup={popup} onOpenChange={handlePopupChange} isMobile={isMobile} />
                </React.Suspense>
            ) : null}
        </div>
    );
}

/**
 * One generated image with its download, which saves the file itself at full
 * size: the same grant the chat drew it with, read whole.
 */
function GeneratedImage({ part, path, directory, onShowPopup }: {
    part: ToolPart;
    path: string;
    directory: string;
    onShowPopup: (content: ToolPopupContent) => void;
}) {
    const { t } = useI18n();
    const content = React.useMemo(() => generatedImageDestination(path), [path]);
    const handleDownload = React.useCallback(async () => {
        try {
            // The grant route matches the path as the call's result names it.
            const blob = await loadMessageImageBlob({ source: path, directory, sessionId: part.sessionID, messageId: part.messageID, signal: new AbortController().signal });
            const name = path.split(/[\\/]/).pop() || 'image.png';
            await saveFile(new File([blob], name, { type: blob.type }));
        } catch {
            toast.error(t('chat.image.downloadFailed'));
        }
    }, [directory, part.messageID, part.sessionID, path, t]);
    return (
        <div className="group/generated-image">
            {/* A row of its own above the image, like a shown page's: the
                button never covers the picture, and fading in moves nothing.
                VS Code has no image grant route and its webview no downloads. */}
            {isVSCodeRuntime() ? null : (
                <div className="flex h-6 items-center justify-end opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/generated-image:opacity-100 pointer-coarse:opacity-100">
                    <ToolbarTooltipButton label={t('chat.image.download')} icon="download" onClick={() => { void handleDownload(); }} />
                </div>
            )}
            <MarkdownContent
                content={content}
                mediaMode="assistant"
                directory={directory}
                settled
                sessionId={part.sessionID}
                messageId={part.messageID}
                onShowPopup={onShowPopup}
                enableFileReferences={false}
            />
        </div>
    );
}
