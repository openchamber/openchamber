import React from 'react';
import type { FilesViewProps } from './files/view/fileViewTypes';
import { Dialogs } from './files/view/FileOperationDialogs';
import { useFilesViewState } from './files/view/useFilesViewState';
import { useFileComments } from './files/view/useFileComments';
import { useFileDirectory } from './files/view/useFileDirectory';
import { useFileSaving } from './files/view/useFileSaving';
import { useFileKeybinds } from './files/view/useFileKeybinds';
import { useFileOpening } from './files/view/useFileOpening';
import { useFileFreshness } from './files/view/useFileFreshness';
import { useFileClosing } from './files/view/useFileClosing';
import { useFileTreeRendering } from './files/view/useFileTreeRendering';
import { useFileKinds } from './files/view/useFileKinds';
import { useFileLanguage } from './files/view/useFileLanguage';
import { useFilePreviewModes } from './files/view/useFilePreviewModes';
import { useFileNavigation } from './files/view/useFileNavigation';
import { useFileEditorExtensions } from './files/view/useFileEditorExtensions';
import { useFileAssets } from './files/view/useFileAssets';
import { useArtifactPreview } from './files/view/useArtifactPreview';
import { useFileImageLoading } from './files/view/useFileImageLoading';
import { useFilePreviewRendering } from './files/view/useFilePreviewRendering';
import { useFileToolbar } from './files/view/useFileToolbar';
import { useFileCanvas } from './files/view/useFileCanvas';
import { renderFileViewer } from './files/view/renderFileViewer';
import { renderFileTreePanel } from './files/view/renderFileTreePanel';
import { renderFullscreenFileViewer } from './files/view/renderFullscreenFileViewer';

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full', visible = true, onCloseFile }) => {
  const filesViewState = useFilesViewState({ mode, visible });
  const fileComments = useFileComments({ ...filesViewState });
  const fileDirectory = useFileDirectory({ ...filesViewState });
  const fileSaving = useFileSaving({ ...filesViewState });
  useFileKeybinds({
    ...filesViewState,
    ...fileSaving,
    isMarkdownPreview: () => fileKinds.isMarkdown && filePreviewModes.getMdViewMode() === 'preview',
  });
  const fileOpening = useFileOpening({ visible, ...filesViewState, ...fileDirectory, ...fileSaving });
  const fileFreshness = useFileFreshness({ visible, ...filesViewState, ...fileSaving });
  const fileClosing = useFileClosing({ visible, onCloseFile, ...filesViewState, ...fileSaving, ...fileOpening });
  const fileTreeRendering = useFileTreeRendering({ ...filesViewState, ...fileDirectory, ...fileOpening });
  const fileKinds = useFileKinds({ visible, ...filesViewState, ...fileDirectory });
  const fileLanguage = useFileLanguage({ ...filesViewState });
  const filePreviewModes = useFilePreviewModes({ ...filesViewState, ...fileSaving, ...fileKinds });
  const fileNavigation = useFileNavigation({ ...filesViewState, ...fileOpening, ...fileKinds });
  const fileEditorExtensions = useFileEditorExtensions({ ...filesViewState, ...fileLanguage, ...fileNavigation });
  const fileAssets = useFileAssets({ ...filesViewState, ...fileSaving, ...fileKinds });
  const artifactPreview = useArtifactPreview({ ...filesViewState, ...fileFreshness, ...fileKinds, ...fileAssets });
  useFileImageLoading({ ...filesViewState, ...fileKinds });
  const filePreviewRendering = useFilePreviewRendering({
    ...filesViewState,
    ...fileComments,
    ...fileKinds,
    ...filePreviewModes,
    ...fileEditorExtensions,
  });
  const fileToolbar = useFileToolbar({
    mode,
    ...filesViewState,
    ...fileComments,
    ...fileSaving,
    ...fileKinds,
    ...filePreviewModes,
    ...fileAssets,
  });
  const fileCanvas = useFileCanvas({
    mode,
    ...filesViewState,
    ...fileComments,
    ...fileSaving,
    ...fileKinds,
    ...filePreviewModes,
    ...fileAssets,
    ...filePreviewRendering,
  });
  const fileViewer = renderFileViewer({
    mode,
    visible,
    ...filesViewState,
    ...fileComments,
    ...fileOpening,
    ...fileClosing,
    ...fileKinds,
    ...filePreviewModes,
    ...fileNavigation,
    ...fileEditorExtensions,
    ...fileAssets,
    ...artifactPreview,
    ...filePreviewRendering,
    ...fileToolbar,
    ...fileCanvas,
  });
  const treePanel = renderFileTreePanel({
    ...filesViewState,
    ...fileDirectory,
    ...fileOpening,
    ...fileTreeRendering,
  });
  const fullscreenViewer = renderFullscreenFileViewer({
    mode,
    ...filesViewState,
    ...fileKinds,
    ...filePreviewModes,
    ...fileNavigation,
    ...fileEditorExtensions,
    ...fileAssets,
    ...artifactPreview,
    ...filePreviewRendering,
    ...fileToolbar,
    ...fileCanvas,
  });
  const { isMobile, screenWidth, showMobilePageContent, dialogInputRef, activeDialog, dialogData, dialogInputValue, setDialogInputValue, isDialogSubmitting } = filesViewState;
  const { uploadElements, handleDialogSubmit } = fileDirectory;
  const { rootRef } = fileClosing;
  const { handleCloseDialog } = filePreviewRendering;

  return (
    // Marks Files as a surface with its own Cmd/Ctrl+F, so Changes and the
    // walkthrough leave the key alone while focus is in here.
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
      {fullscreenViewer}
      {isMobile ? (
        showMobilePageContent ? (
          fileViewer
        ) : (
          treePanel
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
               {treePanel}
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
