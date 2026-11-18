import { type useFileAssets } from './useFileAssets';
import { type useFileDocument } from './useFileDocument';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

export function renderFileHtmlPreview({ fileAssets, fileDocument, tabs, runtime, t }: {
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'annotateWhenLoadedRef' | 'htmlPreview' | 'htmlPreviewAnnotation' | 'htmlPreviewFrameRef'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  runtime: ReturnType<typeof useRuntimeAPIs>['runtime'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { annotateWhenLoadedRef, htmlPreview, htmlPreviewAnnotation, htmlPreviewFrameRef } = fileAssets;
  const { fileContent } = fileDocument;
  const { selectedFile } = tabs;
  if (!selectedFile) return null;
  return (
            !runtime.isVSCode && htmlPreview.status === 'loading' ? (
              <div className="flex h-full items-center justify-center text-muted-foreground typography-ui-label">
                {t('common.loading')}
              </div>
            ) : (
            <div className="h-full overflow-hidden">
              <iframe
                ref={htmlPreviewFrameRef}
                onLoad={() => {
                  if (annotateWhenLoadedRef.current !== selectedFile.path) return;
                  annotateWhenLoadedRef.current = null;
                  if (!htmlPreviewAnnotation.isAnnotating) htmlPreviewAnnotation.toggle();
                }}
                src={htmlPreview.status === 'ready' ? htmlPreview.url : undefined}
                srcDoc={runtime.isVSCode ? (() => {
                  const basePath = selectedFile.path.substring(0, selectedFile.path.lastIndexOf('/') + 1);
                  if (!basePath) return fileContent;
                  return fileContent.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`);
                })() : undefined}
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                title={t('filesView.editor.htmlPreviewTitle')}
              />
            </div>
            )
  );
}
