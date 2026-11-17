import { ActionToolbar, type ToolbarAction } from '@/components/ui/action-toolbar';
import { GoToLineDialog } from '../../GoToLineDialog';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { type FilesViewOptions } from './fileViewTypes';
import { type useFileComments } from './useFileComments';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileViewModes, type useFileDiagram } from './useFilePreviewModes';
import { type useFileAssets } from './useFileAssets';
import { useFileClipboard } from './useFileClipboard';
import { useFileReadAloud } from './useFileReadAloud';
import { useFileSaveButtons } from './useFileSaveButtons';
import { renderFileOpenInApps } from './renderFileOpenInApps';
import { buildFileModeActions } from './buildFileModeActions';
import { buildFileSourceActions } from './buildFileSourceActions';
import { renderFileSaveStatus } from './renderFileSaveStatus';
import { type useFileCanvasState, type useFileFullscreen } from './useFileCanvas';
import { type useFileEditor } from './useFileEditorExtensions';
import { type useFileDocument } from './useFileDocument';
import { type useFileExternalActions } from './useFileExternalActions';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { buildFileActions } from './buildFileActions';
import { renderFileToolbarPath } from './renderFileToolbarPath';

export function useFileToolbar({ fileAssets, draft, fileKinds, canvasState, viewModes, fullscreen, diagram, editor, fileDocument, filePreviewModes, externalActions, fileSaving, markdownPreview, tabs, fileComments, files, isMobile, mode, runtime, t }: {
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'annotateWhenLoadedRef' | 'canAnnotateHtmlPreview' | 'exportDocument' | 'htmlPreviewAnnotation' | 'htmlPreviewUnreachable'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'autoSaveEnabled' | 'autoSaveStatus' | 'isSaving' | 'setAutoSaveEnabled' | 'shortcutOverrides'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'binaryCanvas' | 'canCopy' | 'canCopyPath' | 'canEdit' | 'canUseShikiFileView' | 'displaySelectedPath' | 'hasCanvas' | 'isDrawio' | 'isHtml' | 'isJson' | 'isMarkdown' | 'isMermaid' | 'isNotebook' | 'isSelectedSvg' | 'isTable' | 'isTableView' | 'isTextFile' | 'sourceEditorShown'>;
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'canvasSaved' | 'setCanvasSaved'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'drawioViewMode' | 'jsonViewMode' | 'mermaidViewMode' | 'svgViewMode' | 'tableViewMode' | 'textViewMode'>;
  fullscreen: Pick<ReturnType<typeof useFileFullscreen>, 'changeFullscreen' | 'isFullscreen'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramAutoSaveTimerRef' | 'diagramEditorRef' | 'diagramSaved' | 'setDiagramSaved'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'handleToolbarDropdownOpenChange' | 'isGoToLineOpen' | 'isSearchOpen' | 'isSymbolsOpen' | 'setIsGoToLineOpen' | 'setIsSearchOpen' | 'setIsSymbolsOpen' | 'setWrapLines' | 'wrapLines'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'getHtmlViewMode' | 'getMdViewMode' | 'saveCanvasViewMode' | 'saveDiagramXml' | 'saveDrawioViewMode' | 'saveHtmlViewMode' | 'saveJsonViewMode' | 'saveMdViewMode' | 'saveMermaidViewMode' | 'saveSvgViewMode' | 'saveTableViewMode' | 'saveTextViewMode'>;
  externalActions: Pick<ReturnType<typeof useFileExternalActions>, 'handleOpenInApp' | 'loadOpenInApps' | 'openInApps' | 'openInCacheStale'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'isDirty' | 'saveDraft'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'mdPreviewFindOpen' | 'mdPreviewOutlineOpen' | 'setMdPreviewFindFocusNonce' | 'setMdPreviewFindOpen' | 'setMdPreviewOutlineOpen'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFileReadOptions'>;
  fileComments: Pick<ReturnType<typeof useFileComments>, 'wholeFileComment'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  isMobile: boolean;
  mode: FilesViewOptions['mode'];
  runtime: ReturnType<typeof useRuntimeAPIs>['runtime'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { annotateWhenLoadedRef, canAnnotateHtmlPreview, htmlPreviewAnnotation, htmlPreviewUnreachable } = fileAssets;
  const { autoSaveEnabled, setAutoSaveEnabled, shortcutOverrides } = draft;
  const { canCopyPath, canEdit, displaySelectedPath, isHtml, isTextFile } = fileKinds;

  const { changeFullscreen, isFullscreen } = fullscreen;

  const { editorViewRef, handleToolbarDropdownOpenChange, isGoToLineOpen, setIsGoToLineOpen } = editor;

  const { saveHtmlViewMode } = filePreviewModes;

  const { selectedFile } = tabs;
  const { wholeFileComment } = fileComments;
  const saveButtons = useFileSaveButtons({ canvasState, diagram, filePreviewModes, fileSaving, tabs });

  const readAloud = useFileReadAloud({ fileDocument });

  const clipboard = useFileClipboard({ fileDocument, fileKinds, t });


  const renderFileToolbar = ({
    exitFullscreenOnly = false,
    layout = 'floating',
  }: { exitFullscreenOnly?: boolean; layout?: 'floating' | 'docked' } = {}) => {
    if (!selectedFile) {
      return null;
    }

    const docked = layout === 'docked';
    const openInAppsMenu = renderFileOpenInApps({ externalActions, tabs, t });
    const { openInAppMenuItems } = openInAppsMenu;
    const modeActions = buildFileModeActions({ fileKinds, filePreviewModes, viewModes, t });
    const { hasSourceEditor, modeAction } = modeActions;
    const sourceActions = buildFileSourceActions({ draft, editor, fileKinds, markdownPreview, modeActions, readAloud, viewModes, isMobile, t });
    const { searchAction, outlineAction, goToLineAction, symbolsAction, wrapAction, readAloudAction } = sourceActions;
    const saveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('save_file', shortcutOverrides));

    const annotateAction: ToolbarAction | null = isHtml && !isMobile && !runtime.isVSCode && !htmlPreviewUnreachable ? {
      id: 'annotate',
      label: t('contextPanel.browser.annotate.toggle'),
      icon: 'markup',
      pressed: htmlPreviewAnnotation.isAnnotating,
      onSelect: () => {
        if (canAnnotateHtmlPreview) {
          htmlPreviewAnnotation.toggle();
          return;
        }
        annotateWhenLoadedRef.current = selectedFile.path;
        saveHtmlViewMode('preview');
      },
      pinned: true,
    } : null;

    const copyPathLabel = t('filesView.editor.copyFilePathTitle', { path: displaySelectedPath });
    const showsPathLabel = docked && Boolean(displaySelectedPath) && !isMobile;
    const pathLabelCopies = showsPathLabel && canCopyPath;
    const commentAction: ToolbarAction = {
      id: 'comment-on-file',
      label: t('inlineComment.actions.commentOnFile'),
      icon: 'chat-1',
      pressed: wholeFileComment.isOpen,
      onSelect: wholeFileComment.toggle,
    };
    const fileActions = buildFileActions({
      clipboard, fileAssets, fileKinds, tabs, copyPathLabel, files, isMobile, openInAppMenuItems, pathLabelCopies, t,
    });

    const fullscreenAction: ToolbarAction | null = exitFullscreenOnly
      ? { id: 'fullscreen', label: t('filesView.editor.exitFullscreen'), icon: 'fullscreen-exit', onSelect: () => changeFullscreen(false), pinned: true }
      : !isMobile && mode === 'full'
        ? {
          id: 'fullscreen',
          label: isFullscreen ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen'),
          icon: isFullscreen ? 'fullscreen-exit' : 'fullscreen',
          onSelect: () => changeFullscreen(!isFullscreen),
          pinned: true,
        }
        : null;

    const autoSaveAction: ToolbarAction | null = canEdit && isTextFile ? {
      id: 'auto-save',
      label: t('documentToolbar.autoSave'),
      icon: 'save-3',
      pressed: autoSaveEnabled,
      onSelect: () => setAutoSaveEnabled(!autoSaveEnabled),
    } : null;

    const { status } = renderFileSaveStatus({ canvasState, diagram, draft, fileKinds, fileSaving, saveButtons, viewModes, saveShortcut, t });
    const toolbar = (
      <ActionToolbar
        className={docked ? 'flex-1' : undefined}
        start={renderFileToolbarPath({ clipboard, fileKinds, copyPathLabel, docked, pathLabelCopies, showsPathLabel })}
        status={status}
        inline={hasSourceEditor ? (
          <GoToLineDialog
            open={isGoToLineOpen}
            onOpenChange={setIsGoToLineOpen}
            viewRef={editorViewRef}
            variant="inline"
          />
        ) : null}
        groups={[
          [modeAction, annotateAction],
          [searchAction, outlineAction, commentAction],
        ]}
        menuOnly={[goToLineAction, symbolsAction, wrapAction, readAloudAction, ...fileActions, autoSaveAction]}
        trailing={[fullscreenAction]}
        fold={docked}
        onMenuOpenChange={handleToolbarDropdownOpenChange}
      />
    );

    if (docked) return toolbar;
    return (
      <div className="pointer-events-auto rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 shadow-sm">
        {toolbar}
      </div>
    );
  };
  return {
  renderFileToolbar,
  };
}
