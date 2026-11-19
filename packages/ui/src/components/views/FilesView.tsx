import { renderFileContent } from './files/view/renderFileContent';
import { renderFileExtensionNotice } from './files/view/renderFileExtensionNotice';
import { renderFileSourceEditor } from './files/view/renderFileSourceEditor';
import { renderFileHtmlPreview } from './files/view/renderFileHtmlPreview';
import { renderFileHtmlUnavailable } from './files/view/renderFileHtmlUnavailable';
import { renderFileMarkdownPreview } from './files/view/renderFileMarkdownPreview';
import { renderFileTabs } from './files/view/renderFileTabs';
import { renderFileDiscardDialog } from './files/view/renderFileDiscardDialog';
import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { isBrowserClientRuntime } from '@/lib/desktop';
import { type FilesViewProps } from './files/view/fileViewTypes';
import { Dialogs } from './files/view/FileOperationDialogs';
import { useFileThemes } from './files/view/useFileThemes';
import { useFileScope } from './files/view/useFileScope';
import { useFileLayout } from './files/view/useFileLayout';
import { useFileTabs } from './files/view/useFileTabs';
import { useFileViewModes, useFileDiagram, useFilePreviewModes } from './files/view/useFilePreviewModes';
import { useFileDocument } from './files/view/useFileDocument';
import { useFileDraft, useFileSaving } from './files/view/useFileSaving';
import { useFileCanvasState, useFileFullscreen, useFileCanvas } from './files/view/useFileCanvas';
import { useFileEditor, useFileEditorPanels, useFileEditorExtensions } from './files/view/useFileEditorExtensions';
import { useFileMarkdownPreview, useFileMarkdownOutline } from './files/view/useFileMarkdownPreview';
import { useFileCloseState, useFileClosing } from './files/view/useFileClosing';
import { useFileNavigationRequests, useFileNavigationMask, useFileNavigation } from './files/view/useFileNavigation';
import { useFileExternalActions } from './files/view/useFileExternalActions';
import { useFileComments } from './files/view/useFileComments';
import { useFileDirectory } from './files/view/useFileDirectory';
import { useFileUploads } from './files/view/useFileUploads';
import { useFileOperations } from './files/view/useFileOperations';
import { useFileSearch } from './files/view/useFileSearch';
import { useFileKeybinds, useFileEditorKeybinds } from './files/view/useFileKeybinds';
import { useFileOpening } from './files/view/useFileOpening';
import { useFileFreshness } from './files/view/useFileFreshness';
import { useFileTreeRendering } from './files/view/useFileTreeRendering';
import { useFileKinds } from './files/view/useFileKinds';
import { useFileImageNavigation } from './files/view/useFileImageNavigation';
import { useFileLanguage } from './files/view/useFileLanguage';
import { useFileMobileKeyboard } from './files/view/useFileMobileKeyboard';
import { useFileAssets } from './files/view/useFileAssets';
import { useArtifactPreview } from './files/view/useArtifactPreview';
import { useFileImageLoading } from './files/view/useFileImageLoading';
import { useFilePreviewRendering } from './files/view/useFilePreviewRendering';
import { useFileToolbar } from './files/view/useFileToolbar';
import { renderFileViewer } from './files/view/renderFileViewer';
import { renderFileTreePanel } from './files/view/renderFileTreePanel';
import { renderFullscreenFileViewer } from './files/view/renderFullscreenFileViewer';

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full', visible = true, onCloseFile }) => {
  const { t } = useI18n();
  const { files, runtime, git } = useRuntimeAPIs();
  const { isMobile, isTablet, screenWidth } = useDeviceInfo();
  const guestActions = useGuestActions();
  const isBrowserClient = isBrowserClientRuntime(runtime.platform);
  const alwaysShowActions = isMobile || isTablet;
  const themes = useFileThemes();
  const scope = useFileScope({ isMobile, mode, visible });
  const layout = useFileLayout({ isMobile, mode });
  const tabs = useFileTabs({ scope });
  const viewModes = useFileViewModes();
  const fileDocument = useFileDocument({ scope });
  const draft = useFileDraft();
  const diagram = useFileDiagram();
  const canvasState = useFileCanvasState();
  const fullscreen = useFileFullscreen({ canvasState, draft, tabs });
  const editor = useFileEditor();
  const markdownPreview = useFileMarkdownPreview();
  const closeState = useFileCloseState();
  const navigationRequests = useFileNavigationRequests();
  const externalActions = useFileExternalActions({ scope, tabs, files, t });
  const fileComments = useFileComments({ draft, editor, fileDocument, tabs, isMobile });
  const fileDirectory = useFileDirectory({ fileDocument, layout, scope, tabs, files });
  const uploads = useFileUploads({ fileDirectory, scope });
  const operations = useFileOperations({ fileDirectory, fileDocument, layout, scope, tabs, files, isMobile, t });
  const search = useFileSearch({ scope });
  const fileSaving = useFileSaving({ canvasState, diagram, draft, fileDocument, scope, tabs, files, t });
  useFileKeybinds({
    canvasState, editor, fileSaving, fullscreen, markdownPreview,
    isMarkdownPreview: () => fileKinds.isMarkdown && filePreviewModes.getMdViewMode() === 'preview', isMobile,
  });
  const fileOpening = useFileOpening({
    canvasState, closeState, diagram, draft, fileDirectory, fileDocument, fileSaving, layout, scope, search, tabs,
    viewModes, isMobile, runtime, t, visible,
  });
  const fileFreshness = useFileFreshness({ diagram, draft, fileDocument, fileSaving, scope, tabs, t, visible });
  const fileClosing = useFileClosing({
    canvasState, closeState, draft, fileDocument, fileOpening, fileSaving, layout, scope, tabs, isMobile, onCloseFile,
    visible,
  });
  const fileTreeRendering = useFileTreeRendering({
    externalActions, fileDirectory, fileOpening, operations, scope, tabs, uploads, alwaysShowActions, files,
    guestActions, isBrowserClient, isMobile, t,
  });
  const fileKinds = useFileKinds({ canvasState, draft, fileDocument, scope, tabs, viewModes, files });
  const imageNavigation = useFileImageNavigation({ fileDirectory, fileKinds, scope, tabs, files, visible });
  const navigationMask = useFileNavigationMask({ fileDocument, fileKinds, navigationRequests, tabs });
  useFileEditorPanels({ editor, fileKinds, isMobile });
  useFileMarkdownOutline({ fileKinds, markdownPreview, tabs, viewModes });
  const fileLanguage = useFileLanguage({ tabs });
  const filePreviewModes = useFilePreviewModes({
    canvasState, diagram, draft, fileDocument, fileKinds, fileSaving, fullscreen, markdownPreview, scope, tabs,
    viewModes, files, isMobile, t,
  });
  useFileNavigation({
    closeState, draft, editor, fileDocument, fileKinds, fileOpening, navigationRequests, scope, tabs, viewModes,
  });
  const mobileKeyboard = useFileMobileKeyboard({ editor, isMobile });
  useFileEditorKeybinds({ editor, fileKinds, viewModes, isMobile });
  const fileEditorExtensions = useFileEditorExtensions({ editor, fileLanguage, mobileKeyboard, scope, tabs, themes, files, git, isMobile, t });
  const fileAssets = useFileAssets({ draft, fileDocument, fileKinds, fileSaving, scope, tabs, viewModes, files, isMobile, runtime, t });
  const artifacts = useArtifactPreview({
    draft, fileAssets, fileDocument, fileFreshness, fileKinds, imageNavigation, layout, tabs, viewModes, files, t,
  });
  useFileImageLoading({ fileDocument, fileKinds, scope, tabs, files, t });
  const filePreviewRendering = useFilePreviewRendering({
    draft, editor, fileComments, fileDocument, fileEditorExtensions, fileKinds, filePreviewModes, markdownPreview, scope,
    tabs, themes, viewModes,
  });
  const fileToolbar = useFileToolbar({
    fileAssets, draft, fileKinds, canvasState, viewModes, fullscreen, diagram, editor, fileDocument, filePreviewModes,
    externalActions, fileSaving, markdownPreview, tabs, fileComments, files, isMobile, mode, runtime, t,
  });
  const fileCanvas = useFileCanvas({
    canvasState, draft, fileAssets, fileDocument, fileKinds, filePreviewModes, filePreviewRendering, fileSaving,
    fullscreen, tabs, viewModes, files, mode, t,
  });
  const discardDialog = renderFileDiscardDialog({ closeState, draft, fileClosing, t });
  const tabsRow = () => renderFileTabs({ fileClosing, fileOpening, layout, scope, tabs, alwaysShowActions, isMobile, t });
  const markdownContent = () => renderFileMarkdownPreview({
    fileComments, fileDocument, fileEditorExtensions, filePreviewRendering, fullscreen, markdownPreview, tabs, t,
  });
  const htmlUnavailableContent = () => renderFileHtmlUnavailable({ tabs, viewModes, t });
  const htmlContent = () => renderFileHtmlPreview({ fileAssets, fileDocument, tabs, runtime, t });
  const sourceEditor = () => renderFileSourceEditor({
    draft, editor, fileComments, fileDocument, fileEditorExtensions, fileKinds, filePreviewRendering, fullscreen,
    mobileKeyboard, navigationMask, isMobile, t, visible,
  });
  const extensionNotice = renderFileExtensionNotice({ fileCanvas, fileKinds, t });
  const content = renderFileContent({
    artifacts, diagram, draft, fileAssets, fileCanvas, fileDocument, fileKinds, filePreviewModes, filePreviewRendering,
    tabs, viewModes, htmlContent, htmlUnavailableContent, markdownContent, sourceEditor, t,
  });
  const fileViewer = renderFileViewer({
    commentPanel: !(mode === 'full' && fullscreen.isFullscreen) && fileComments.wholeFileCommentPanel, content,
    discardDialog, extensionNotice, hasFile: Boolean(tabs.selectedFile), isLargeFile: filePreviewRendering.isLargeFile,
    previewScroller: filePreviewRendering.setMainPreviewScroller, showTabs: layout.showEditorTabsRow, tabsRow,
    toolbar: fileToolbar.renderFileToolbar({ layout: 'docked' }),
  });
  const fileTreePanel = renderFileTreePanel({
    fileDirectory, fileOpening, fileTreeRendering, operations, scope, search, tabs, uploads, isMobile, t,
  });
  const fullscreenFileViewer = renderFullscreenFileViewer({
    artifacts, draft, editor, fileAssets, fileCanvas, fileComments, fileDocument, fileEditorExtensions, fileKinds,
    filePreviewModes, filePreviewRendering, fileToolbar, fullscreen, markdownPreview, mobileKeyboard, navigationMask,
    tabs, viewModes, isMobile, mode, t,
  });
  const { showMobilePageContent } = layout;
  const { dialogInputRef, activeDialog, dialogData, dialogInputValue, setDialogInputValue, isDialogSubmitting, handleDialogSubmit, handleCloseDialog } = operations;
  const { uploadElements } = uploads;
  const { rootRef } = fileClosing;

  return (
    <div ref={rootRef} data-find-surface="" className="flex h-full min-h-0 overflow-hidden bg-background relative">
      <Dialogs
        activeDialog={activeDialog}
        dialogData={dialogData}
        dialogInputValue={dialogInputValue}
        onDialogInputChange={setDialogInputValue}
        isDialogSubmitting={isDialogSubmitting}
        onDialogSubmit={handleDialogSubmit}
        onClose={handleCloseDialog}
        inputRef={dialogInputRef}
      />
      {uploadElements}
      {fullscreenFileViewer}
      {isMobile ? (
        showMobilePageContent ? (
          fileViewer
        ) : (
          fileTreePanel
        )
      ) : mode === 'editor-only' ? (
        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
            {fileViewer}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 min-w-0 gap-3 px-3 pb-3 pt-2">
          {screenWidth >= 700 && (
            <div className="w-72 flex-shrink-0 min-h-0 overflow-hidden">
              {fileTreePanel}
            </div>
          )}
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl border border-edge bg-background">
            {fileViewer}
          </div>
        </div>
      )}
    </div>
  );
};
