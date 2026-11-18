import { DocumentSymbolsPanel } from '../../DocumentSymbolsPanel';
import { DetachableEditorMarker } from '@/components/layout/zoneInteractiveContext';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { FilePositionEditor } from './FilePositionEditor';
import { type useFileComments } from './useFileComments';
import { type useFileKinds } from './useFileKinds';
import { type useFileEditorExtensions, type useFileEditor } from './useFileEditorExtensions';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import { type useFileDraft } from './useFileSaving';
import { type useFileDocument } from './useFileDocument';
import { type useFileFullscreen } from './useFileCanvas';
import { type useFileMobileKeyboard } from './useFileMobileKeyboard';
import { type useFileNavigationMask } from './useFileNavigation';
import { useI18n } from '@/lib/i18n';

export function renderFileSourceEditor({ draft, editor, fileComments, fileDocument, fileEditorExtensions, fileKinds, filePreviewRendering, fullscreen, mobileKeyboard, navigationMask, isMobile, t, visible }: {
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent' | 'setDraftContent'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'editorWrapperRef' | 'fileEditorKeymap' | 'isSearchOpen' | 'isSymbolsOpen' | 'setEditorViewReadyNonce' | 'setIsSearchOpen' | 'setIsSymbolsOpen'>;
  fileComments: Pick<ReturnType<typeof useFileComments>, 'lineNumbersConfig' | 'lineSelection'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'filePositionKey'>;
  fileEditorExtensions: Pick<ReturnType<typeof useFileEditorExtensions>, 'applyGitBaseline' | 'editorExtensions'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit'>;
  filePreviewRendering: Pick<ReturnType<typeof useFilePreviewRendering>, 'blockWidgets'>;
  fullscreen: Pick<ReturnType<typeof useFileFullscreen>, 'isFullscreen'>;
  mobileKeyboard: Pick<ReturnType<typeof useFileMobileKeyboard>, 'nudgeEditorSelectionAboveKeyboard'>;
  navigationMask: Pick<ReturnType<typeof useFileNavigationMask>, 'shouldMaskEditorForPendingNavigation'>;
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
  visible: boolean;
}) {
  const { draftContent, setDraftContent } = draft;
  const { editorViewRef, editorWrapperRef, fileEditorKeymap, isSearchOpen, isSymbolsOpen, setEditorViewReadyNonce, setIsSearchOpen, setIsSymbolsOpen } = editor;
  const { lineNumbersConfig, lineSelection } = fileComments;
  const { filePositionKey } = fileDocument;
  const { applyGitBaseline, editorExtensions } = fileEditorExtensions;
  const { canEdit } = fileKinds;
  const { blockWidgets } = filePreviewRendering;
  const { isFullscreen } = fullscreen;
  const { nudgeEditorSelectionAboveKeyboard } = mobileKeyboard;
  const { shouldMaskEditorForPendingNavigation } = navigationMask;
  return (
            <div
              className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}
              ref={editorWrapperRef}
            >
              {!isFullscreen && (
                <DocumentSymbolsPanel open={isSymbolsOpen} onOpenChange={setIsSymbolsOpen} viewRef={editorViewRef} />
              )}
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
                <DetachableEditorMarker />
                <FilePositionEditor
                  key={filePositionKey}
                  positionKey={filePositionKey}
                  detached={!visible}
                  value={draftContent}
                  onChange={setDraftContent}
                  readOnly={!canEdit}
                  vimMode={fileEditorKeymap === 'vim'}
                  extensions={editorExtensions}
                  className={cn('h-full', isMobile && 'oc-compact-search')}
                  blockWidgets={blockWidgets}
                  onViewReady={(view) => {
                    editorViewRef.current = view;
                    applyGitBaseline(view);
                    setEditorViewReadyNonce((value) => value + 1);
                    window.requestAnimationFrame(() => {
                      nudgeEditorSelectionAboveKeyboard(view);
                    });
                  }}
                  onViewDestroy={() => {
                    if (editorViewRef.current) {
                      editorViewRef.current = null;
                    }
                    setEditorViewReadyNonce((value) => value + 1);
                  }}
                  enableSearch
                  searchOpen={isSearchOpen}
                  onSearchOpenChange={setIsSearchOpen}
                  highlightLines={lineSelection
                    ? {
                      start: Math.min(lineSelection.start, lineSelection.end),
                      end: Math.max(lineSelection.start, lineSelection.end),
                    }
                    : undefined}
                  lineNumbersConfig={lineNumbersConfig}
                />
              </div>
              {shouldMaskEditorForPendingNavigation && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                  <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('filesView.state.openingFileAtChange')}
                  </div>
                </div>
              )}
            </div>
  );
}
