import React from 'react';

import { useOpenUIHost } from '@/components/chat/openui/openuiHost';
import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import type { JsonValue } from '@/lib/opencode/model';
import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { toast } from '@/components/ui';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { useUIStore } from '@/stores/useUIStore';
import { z } from 'zod';

import { HTML_RENDER_MIN_HEIGHT, buildHtmlRenderDocument, clampHtmlRenderHeight, htmlRenderFileName, type HtmlRenderAnswerState, type HtmlRenderSubmission } from './htmlRender';
import { HtmlRenderDocument, HtmlRenderToolbar, PageSelectionScope } from './HtmlRenderFrame';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';
import { useOpenUIHtml } from './renderPageImages';

// Virtual rows return at their last measured height. Keep one document per
// page, bounded by count and source bytes rather than retaining every revision.
const rememberedHeights = new Map<string, { revision: string; height: number }>();
let rememberedHeightCharacters = 0;
const rememberHeight = (pageId: string, revision: string, height: number) => {
    const previous = rememberedHeights.get(pageId);
    if (previous) rememberedHeightCharacters -= pageId.length + previous.revision.length;
    rememberedHeights.delete(pageId);
    rememberedHeights.set(pageId, { revision, height });
    rememberedHeightCharacters += pageId.length + revision.length;
    for (const [oldest, entry] of rememberedHeights) {
        if (rememberedHeights.size <= 500 && rememberedHeightCharacters <= 1024 * 1024) break;
        rememberedHeights.delete(oldest);
        rememberedHeightCharacters -= oldest.length + entry.revision.length;
    }
};

export function OpenUIHtmlView({ html, height, title }: { html: string; height?: number; title?: string }) {
    const { host, occurrence } = useOpenUIHost();
    const directory = host.owner.directory;
    const pageId = [
        host.owner.runtimeKey,
        host.owner.directory,
        host.owner.sessionId,
        host.owner.messageId,
        host.owner.partId,
        occurrence,
    ].join('\0');
    const documentRevision = `${host.renderKey}\0${html}`;
    const loadedHtml = useOpenUIHtml({
        html,
        sessionId: host.owner.sessionId,
        messageId: host.owner.messageId,
        directory,
        pageId,
        renderKey: host.renderKey,
        permittedSources: host.initialMediaSources,
    });
    const restored = rememberedHeights.get(pageId);
    const initialHeight = restored?.revision === documentRevision ? restored.height : clampHtmlRenderHeight(height ?? HTML_RENDER_MIN_HEIGHT);
    const [measured, setMeasured] = React.useState({ pageId, revision: documentRevision, height: initialHeight });
    const contentHeight = measured.pageId === pageId && measured.revision === documentRevision ? measured.height : initialHeight;
    const onContentHeight = React.useCallback((next: number) => {
        const height = clampHtmlRenderHeight(next);
        rememberHeight(pageId, documentRevision, height);
        setMeasured({ pageId, revision: documentRevision, height });
    }, [pageId, documentRevision]);
    const [fullscreen, setFullscreen] = React.useState(false);
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const theme = useHtmlRenderTheme();
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const answerState = React.useMemo<HtmlRenderAnswerState>(() => ({
        waiting: host.submission.kind === 'pending' || host.access.kind === 'interactive',
        pending: host.submission.kind === 'pending',
        terminal: host.submission.kind !== 'pending' && host.access.kind === 'readonly' ? host.access.reason : undefined,
        answer: host.answer,
    }), [host]);
    const submit = React.useCallback(async (submission: HtmlRenderSubmission) => {
        if (!host.canInteract()) throw new Error(t('chat.htmlRender.answerFailed'));
        const data: JsonValue = z.json().parse(submission.data);
        await host.submit({ summary: submission.summary, data });
    }, [host, t]);
    const describePage = React.useCallback((payload: BrowserAnnotationPayload): BrowserAnnotationPayload => ({
        ...payload,
        pageUrl: '',
        pageTitle: title ?? '',
    }), [title]);
    const annotation = useFrameAnnotation({
        frameRef,
        directory,
        pageKey: `${pageId}:${host.renderKey}`,
        intro: t('chat.htmlRender.annotate.intro'),
        describePage,
    });
    const canAnnotate = !isMobile && !isVSCodeRuntime() && loadedHtml !== null;
    const canDownload = !isVSCodeRuntime();
    const download = React.useCallback(async () => {
        if (!loadedHtml) return;
        const file = new File([buildHtmlRenderDocument(loadedHtml, theme)], htmlRenderFileName(title ?? ''), { type: 'text/html' });
        try {
            if (isCapacitorMobileApp()) {
                await shareFileFromNativeApp(file);
                return;
            }
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.download = file.name;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch {
            toast.error(t('chat.htmlRender.downloadFailed'));
        }
    }, [loadedHtml, t, theme, title]);

    if (loadedHtml === null) return <div style={{ height: contentHeight }} />;
    return (
        <div className="group/html-render my-2">
            <HtmlRenderToolbar
                canAnnotate={canAnnotate}
                annotationActive={annotation.isAnnotating}
                annotate={{ label: t('contextPanel.browser.annotate.toggle'), pressed: annotation.isAnnotating, onClick: annotation.toggle }}
                fullscreen={{ label: t('chat.htmlRender.fullscreen'), onClick: () => setFullscreen(true) }}
                download={canDownload ? { label: t('chat.htmlRender.download'), onClick: () => { void download(); } } : undefined}
            />
            <PageSelectionScope key={`${pageId}:${documentRevision}`} messageId={host.owner.messageId} partId={host.owner.partId} className="relative" style={{ height: contentHeight }}>
                <HtmlRenderDocument
                    key={`${pageId}:${documentRevision}:inline`}
                    partId={host.owner.partId}
                    viewId={`${pageId}:${host.renderKey}`}
                    html={loadedHtml}
                    title={title ?? ''}
                    className="block size-full border-0 bg-transparent"
                    answerState={answerState}
                    onSubmit={submit}
                    onContentHeight={onContentHeight}
                    frameRef={frameRef}
                />
                <Dialog open={fullscreen} onOpenChange={setFullscreen}>
                    <DialogContent className="max-w-[min(72rem,100%)] gap-0 overflow-hidden bg-background p-0">
                        <DialogTitle className="truncate px-5 py-4 pe-12">{title}</DialogTitle>
                        {fullscreen ? (
                            <PageSelectionScope messageId={host.owner.messageId} className="flex min-h-0 flex-col px-5 pb-5">
                                <HtmlRenderDocument
                                    key={`${pageId}:${documentRevision}:fullscreen`}
                                    partId={host.owner.partId}
                                    viewId={`${pageId}:${host.renderKey}`}
                                    html={loadedHtml}
                                    title={title ?? ''}
                                    className="block min-h-0 w-full shrink border-0 bg-transparent"
                                    style={{ height: contentHeight }}
                                    contained
                                    answerState={answerState}
                                    onSubmit={submit}
                                    onContentHeight={onContentHeight}
                                />
                            </PageSelectionScope>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </PageSelectionScope>
        </div>
    );
}
