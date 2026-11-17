import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { ActionToolbar, ToolbarTooltipButton, TooltipLabelWithShortcut, type ToolbarAction, type ToolbarGroup } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GoToLineDialog } from '../../GoToLineDialog';
import { FilePathLabel } from '../FilePathLabel';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileComments } from './useFileComments';
import type { useFileSaving } from './useFileSaving';
import type { useFileKinds } from './useFileKinds';
import type { useFilePreviewModes } from './useFilePreviewModes';
import type { useFileAssets } from './useFileAssets';

export function useFileToolbar({
  mode, t, files, runtime, isMobile, wrapLines, setWrapLines, isFullscreen, changeFullscreen, isSearchOpen,
  setIsSearchOpen, handleToolbarDropdownOpenChange, textViewMode, jsonViewMode, drawioViewMode, canvasViewMode,
  svgViewMode, mermaidViewMode, tableViewMode, selectedFile, selectedFileReadOptions, fileContent, isTTSPlaying,
  playTTS, stopTTS, isSaving, diagramAutoSaveTimerRef, diagramEditorRef, autoSaveStatus, diagramSaved,
  setDiagramSaved, canvasSaved, setCanvasSaved, autoSaveEnabled, shortcutOverrides, setAutoSaveEnabled,
  copiedContentTimeoutRef, copiedPathTimeoutRef, editorViewRef, copiedContent, setCopiedContent, copiedPath,
  setCopiedPath, isGoToLineOpen, setIsGoToLineOpen, isSymbolsOpen, setIsSymbolsOpen, mdPreviewFindOpen,
  setMdPreviewFindOpen, setMdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen, openInApps,
  openInCacheStale, loadOpenInApps, handleOpenInApp, showMessageTTSButtons, wholeFileComment, isDirty, saveDraft,
  isSelectedSvg, displaySelectedPath, canCopy, canCopyPath, canEdit, isTextFile, binaryCanvas, isMarkdown, isJson,
  isHtml, isDrawio, isMermaid, isTable, isNotebook, isTableView, hasCanvas, canUseShikiFileView, sourceEditorShown,
  saveTextViewMode, saveMdViewMode, getMdViewMode, saveSvgViewMode, saveMermaidViewMode, saveTableViewMode,
  saveJsonViewMode, saveHtmlViewMode, saveDrawioViewMode, saveCanvasViewMode, saveDiagramXml, getHtmlViewMode,
  htmlPreviewUnreachable, htmlPreviewAnnotation, canAnnotateHtmlPreview, annotateWhenLoadedRef, exportDocument,
}: Pick<FilesViewOptions, 'mode'> &
Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'runtime' | 'isMobile' | 'wrapLines' | 'setWrapLines' | 'isFullscreen' | 'changeFullscreen' |
  'isSearchOpen' | 'setIsSearchOpen' | 'handleToolbarDropdownOpenChange' | 'textViewMode' | 'jsonViewMode' |
  'drawioViewMode' | 'canvasViewMode' | 'svgViewMode' | 'mermaidViewMode' | 'tableViewMode' | 'selectedFile' |
  'selectedFileReadOptions' | 'fileContent' | 'isTTSPlaying' | 'playTTS' | 'stopTTS' | 'isSaving' |
  'diagramAutoSaveTimerRef' | 'diagramEditorRef' | 'autoSaveStatus' | 'diagramSaved' | 'setDiagramSaved' |
  'canvasSaved' | 'setCanvasSaved' | 'autoSaveEnabled' | 'shortcutOverrides' | 'setAutoSaveEnabled' |
  'copiedContentTimeoutRef' | 'copiedPathTimeoutRef' | 'editorViewRef' | 'copiedContent' | 'setCopiedContent' |
  'copiedPath' | 'setCopiedPath' | 'isGoToLineOpen' | 'setIsGoToLineOpen' | 'isSymbolsOpen' | 'setIsSymbolsOpen' |
  'mdPreviewFindOpen' | 'setMdPreviewFindOpen' | 'setMdPreviewFindFocusNonce' | 'mdPreviewOutlineOpen' |
  'setMdPreviewOutlineOpen' | 'openInApps' | 'openInCacheStale' | 'loadOpenInApps' | 'handleOpenInApp' |
  'showMessageTTSButtons'> &
Pick<ReturnType<typeof useFileComments>,
  'wholeFileComment'> &
Pick<ReturnType<typeof useFileSaving>,
  'isDirty' | 'saveDraft'> &
Pick<ReturnType<typeof useFileKinds>,
  'isSelectedSvg' | 'displaySelectedPath' | 'canCopy' | 'canCopyPath' | 'canEdit' | 'isTextFile' | 'binaryCanvas' |
  'isMarkdown' | 'isJson' | 'isHtml' | 'isDrawio' | 'isMermaid' | 'isTable' | 'isNotebook' | 'isTableView' |
  'hasCanvas' | 'canUseShikiFileView' | 'sourceEditorShown'> &
Pick<ReturnType<typeof useFilePreviewModes>,
  'saveTextViewMode' | 'saveMdViewMode' | 'getMdViewMode' | 'saveSvgViewMode' | 'saveMermaidViewMode' |
  'saveTableViewMode' | 'saveJsonViewMode' | 'saveHtmlViewMode' | 'saveDrawioViewMode' | 'saveCanvasViewMode' |
  'saveDiagramXml' | 'getHtmlViewMode'> &
Pick<ReturnType<typeof useFileAssets>,
  'htmlPreviewUnreachable' | 'htmlPreviewAnnotation' | 'canAnnotateHtmlPreview' | 'annotateWhenLoadedRef' |
  'exportDocument'>) {
  const renderFileToolbar = ({
    exitFullscreenOnly = false,
    layout = 'floating',
  }: { exitFullscreenOnly?: boolean; layout?: 'floating' | 'docked' } = {}) => {
    if (!selectedFile) {
      return null;
    }

    const docked = layout === 'docked';
    const saveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('save_file', shortcutOverrides));

    // `announce` is for the "More actions" menu: the menu closes on select, so
    // the button's check-mark feedback would never be seen there.
    const copyContents = async (announce: boolean) => {
      const result = await copyTextToClipboard(fileContent);
      if (!result.ok) {
        toast.error(t('filesView.toast.copyFailed'));
        return;
      }
      if (announce) {
        toast.success(t('filesView.editor.toast.contentsCopied'));
        return;
      }
      setCopiedContent(true);
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
      copiedContentTimeoutRef.current = window.setTimeout(() => {
        setCopiedContent(false);
      }, 1200);
    };

    const copyPath = async (announce: boolean) => {
      const result = await copyTextToClipboard(displaySelectedPath);
      if (!result.ok) {
        toast.error(t('filesView.toast.copyFailed'));
        return;
      }
      if (announce) {
        toast.success(t('sidebarFilesTree.toast.pathCopied'));
        return;
      }
      setCopiedPath(true);
      if (copiedPathTimeoutRef.current !== null) {
        window.clearTimeout(copiedPathTimeoutRef.current);
      }
      copiedPathTimeoutRef.current = window.setTimeout(() => {
        setCopiedPath(false);
      }, 1200);
    };

    const downloadSelectedFile = () => {
      const fn = files.downloadFile;
      if (fn) void fn(selectedFile.path, selectedFileReadOptions).catch((error) => {
        console.error('Download failed:', error);
        toast.error(t('sidebarFilesTree.toast.operationFailed'));
      });
    };

    const toggleTTS = () => {
      if (isTTSPlaying) {
        stopTTS();
      } else if (fileContent.trim()) {
        void playTTS(fileContent);
      }
    };

    const saveCanvas = async () => {
      const saved = await saveDraft();
      if (!saved) return;
      setCanvasSaved(true);
      setTimeout(() => setCanvasSaved(false), 1500);
    };

    const saveDiagram = async () => {
      const xml = diagramEditorRef.current?.getXml();
      if (diagramAutoSaveTimerRef.current) {
        clearTimeout(diagramAutoSaveTimerRef.current);
        diagramAutoSaveTimerRef.current = null;
      }
      if (selectedFile?.path && xml) {
        const saved = await saveDiagramXml(selectedFile.path, xml);
        if (!saved) return;
        setDiagramSaved(true);
        setTimeout(() => setDiagramSaved(false), 1500);
      }
    };

    const openInAppMenuItems = (
      <>
        {/* Always first: whatever app the OS has for this file type. */}
        <DropdownMenuItem
          className="flex items-center gap-2"
          onClick={() => {
            if (!selectedFile?.path) return;
            void openDesktopPath(selectedFile.path).then((opened) => {
              if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
            });
          }}
        >
          <Icon name="external-link" className="size-4" />
          <span className="typography-ui-label text-foreground">{t('sidebarFilesTree.menu.openInDefaultApp')}</span>
        </DropdownMenuItem>
        {openInApps.length > 0 ? <DropdownMenuSeparator /> : null}
        {openInApps.map((app) => (
          <DropdownMenuItem
            key={app.id}
            className="flex items-center gap-2"
            onClick={() => void handleOpenInApp(app)}
          >
            <Icon name={app.icon} className="size-4" />
            <span className="typography-ui-label text-foreground">{app.label}</span>
          </DropdownMenuItem>
        ))}
        {openInCacheStale ? (
          <DropdownMenuItem
            className="flex items-center gap-2"
            onClick={() => void loadOpenInApps(true)}
          >
            <Icon name="refresh" className="size-4" />
            <span className="typography-ui-label text-foreground">{t('filesView.editor.refreshApps')}</span>
          </DropdownMenuItem>
        ) : null}
      </>
    );

    // Which buttons the row has depends on what the file is, never on the
    // mode it shows: an action the current mode cannot do switches to the
    // source editor first, so changing modes moves no button.
    // `isTextFile` holds in every mode; `isSelectedNonText` counts an SVG preview as an image.
    // A read-only file shows its source in the code preview, not an editor, except
    // Markdown, draw.io and canvases, which open CodeMirror read-only.
    const hasSourceEditor = isTextFile && !(hasCanvas && binaryCanvas) && (canEdit || isMarkdown || isDrawio || hasCanvas);
    const mdPreview = isMarkdown && getMdViewMode() === 'preview';

    const openSourceEditor = () => {
      if (sourceEditorShown) return;
      if (hasCanvas) saveCanvasViewMode('edit');
      else if (isDrawio) saveDrawioViewMode('edit');
      else if (isMarkdown) saveMdViewMode('edit');
      else if (isHtml) saveHtmlViewMode('edit');
      else if (isJson) saveJsonViewMode('text');
      else if (isSelectedSvg) saveSvgViewMode('edit');
      else if (isMermaid) saveMermaidViewMode('edit');
      else if (isTableView) saveTableViewMode('text');
      else saveTextViewMode('edit');
    };

    const previewLabel = t('documentToolbar.preview');
    const previewToggle = (preview: boolean, setPreview: (preview: boolean) => void): ToolbarAction => ({
      id: 'mode',
      label: previewLabel,
      icon: 'eye',
      pressed: preview,
      onSelect: () => setPreview(!preview),
      pinned: true,
    });
    const modeAction: ToolbarAction | null = hasCanvas
      // Bytes have no source view.
      ? (binaryCanvas ? null : previewToggle(canvasViewMode === 'preview', (on) => saveCanvasViewMode(on ? 'preview' : 'edit')))
      : isDrawio ? previewToggle(drawioViewMode === 'preview', (on) => saveDrawioViewMode(on ? 'preview' : 'edit'))
      : isMarkdown ? previewToggle(mdPreview, (on) => saveMdViewMode(on ? 'preview' : 'edit'))
      : isHtml ? previewToggle(getHtmlViewMode() === 'preview', (on) => saveHtmlViewMode(on ? 'preview' : 'edit'))
      : isSelectedSvg ? previewToggle(svgViewMode === 'preview', (on) => saveSvgViewMode(on ? 'preview' : 'edit'))
      : isMermaid ? previewToggle(mermaidViewMode === 'preview', (on) => saveMermaidViewMode(on ? 'preview' : 'edit'))
      : isTableView ? {
        id: 'mode',
        label: isNotebook ? previewLabel : t('documentToolbar.tableView'),
        icon: isNotebook ? 'eye' : 'table-2',
        pressed: tableViewMode === 'table',
        onSelect: () => saveTableViewMode(tableViewMode === 'table' ? 'text' : 'table'),
        pinned: true,
      }
      : isJson ? {
        id: 'mode',
        label: t('documentToolbar.treeView'),
        icon: 'node-tree',
        pressed: jsonViewMode === 'tree',
        onSelect: () => saveJsonViewMode(jsonViewMode === 'tree' ? 'text' : 'tree'),
        pinned: true,
      }
      : canUseShikiFileView && canEdit ? previewToggle(textViewMode === 'view', (on) => saveTextViewMode(on ? 'view' : 'edit'))
      : null;

    // Annotation needs the rendered page: from the source it switches to the
    // preview and starts once the page has loaded.
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

    const searchOpen = mdPreview ? mdPreviewFindOpen : (sourceEditorShown && isSearchOpen);
    // A table has its own search, which filters rows.
    const searchAction: ToolbarAction | null = hasSourceEditor && !(isTable && tableViewMode === 'table') ? {
      id: 'search',
      label: t('filesView.editor.findInFile'),
      icon: 'search',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('find_in_file', shortcutOverrides), ''),
      pressed: searchOpen,
      onSelect: () => {
        // The Markdown preview has its own find bar; every other mode searches the source.
        if (mdPreview) {
          if (mdPreviewFindOpen) {
            setMdPreviewFindOpen(false);
            return;
          }
          setMdPreviewFindOpen(true);
          setMdPreviewFindFocusNonce((value) => value + 1);
          return;
        }
        openSourceEditor();
        setIsSearchOpen(!searchOpen);
      },
    } : null;

    // Every Markdown file has the button in every mode, so the row never
    // changes with the mode, and pressing it never changes the mode. The
    // preview lists its rendered headings; the source lists them through the
    // editor's own symbols panel, which reads a Markdown file's headings too.
    const outlineAction: ToolbarAction | null = isMarkdown && isTextFile ? {
      id: 'outline',
      label: t('filesView.preview.outline.label'),
      icon: 'list-unordered',
      pressed: mdPreview ? mdPreviewOutlineOpen : sourceEditorShown && isSymbolsOpen,
      onSelect: () => {
        if (mdPreview) {
          setMdPreviewOutlineOpen(!mdPreviewOutlineOpen);
          return;
        }
        openSourceEditor();
        setIsSymbolsOpen((open) => !sourceEditorShown || !open);
      },
      // Either panel treats a press on this button as its own toggle.
      buttonAttributes: { 'data-markdown-outline-toggle': '', 'data-document-symbols-toggle': '' },
    } : null;

    const goToLineAction: ToolbarAction | null = hasSourceEditor ? {
      id: 'go-to-line',
      label: t('filesView.editor.goToLine'),
      icon: 'hashtag',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('open_go_to_line', shortcutOverrides), ''),
      pressed: isGoToLineOpen,
      onSelect: () => {
        openSourceEditor();
        setIsGoToLineOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-go-to-line-toggle': '' },
    } : null;

    const symbolsAction: ToolbarAction | null = hasSourceEditor && !isMobile ? {
      id: 'symbols',
      label: t('filesView.editor.symbols'),
      icon: 'braces',
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('open_document_symbols', shortcutOverrides), ''),
      pressed: isSymbolsOpen,
      onSelect: () => {
        openSourceEditor();
        setIsSymbolsOpen((open) => !sourceEditorShown || !open);
      },
      buttonAttributes: { 'data-document-symbols-toggle': '' },
    } : null;

    const wrapAction: ToolbarAction | null = isTextFile ? {
      id: 'wrap',
      label: t('documentToolbar.wrapLines'),
      icon: 'text-wrap',
      pressed: wrapLines,
      onSelect: () => setWrapLines(!wrapLines),
    } : null;

    const readAloudAction: ToolbarAction | null = isMarkdown && showMessageTTSButtons ? {
      id: 'read-aloud',
      label: isTTSPlaying ? t('filesView.tts.stopSpeaking') : t('filesView.tts.readAloud'),
      icon: 'volume-up',
      iconClassName: isTTSPlaying ? 'text-[var(--primary-text)]' : undefined,
      onSelect: toggleTTS,
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
    const fileActions: ToolbarGroup = [
      // Every item hands the path to this machine's OS. A remote server, WSL
      // included, keeps its files elsewhere, so the menu would only fail there.
      isDesktopLocalOriginActive() && {
        id: 'open-in-app',
        label: t('filesView.editor.openInDesktopApp'),
        icon: 'external-link',
        menu: openInAppMenuItems,
      },
      canCopy && {
        id: 'copy-contents',
        label: t('filesView.editor.copyFileContents'),
        icon: 'file-copy',
        done: copiedContent,
        onSelect: () => void copyContents(false),
        onMenuSelect: () => void copyContents(true),
      },
      // Where the toolbar names the file, a click on the name copies its path.
      canCopyPath && !pathLabelCopies && {
        id: 'copy-path',
        label: copyPathLabel,
        icon: 'link',
        done: copiedPath,
        onSelect: () => void copyPath(false),
        onMenuSelect: () => void copyPath(true),
      },
      Boolean(files.downloadFile) && {
        id: 'download',
        label: t('filesView.editor.saveFile'),
        icon: 'download',
        onSelect: downloadSelectedFile,
      },
      isMarkdown && {
        id: 'export-word',
        label: t('filesView.export.word'),
        icon: 'download',
        onSelect: () => void exportDocument('docx'),
      },
      isMarkdown && !isMobile && {
        id: 'export-pdf',
        label: t('filesView.export.pdf'),
        icon: 'download',
        onSelect: () => void exportDocument('pdf'),
      },
      isTable && {
        id: 'export-excel',
        label: t('filesView.export.excel'),
        icon: 'download',
        onSelect: () => void exportDocument('xlsx'),
      },
    ];

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

    const statusContent = hasCanvas && canvasViewMode === 'preview' ? (
      <ToolbarTooltipButton label={t('filesView.fileEditor.save')} icon="save-3" done={canvasSaved} onClick={() => void saveCanvas()} />
    ) : isDrawio && drawioViewMode === 'preview' ? (
      <ToolbarTooltipButton label={t('filesView.diagram.saveDiagram')} icon="save-3" done={diagramSaved} onClick={() => void saveDiagram()} />
    ) : isSaving ? (
      <span className="flex items-center gap-1 px-1 text-muted-foreground typography-meta">
        <Icon name="loader-4" className="size-3.5 animate-spin" />
        {t('filesView.editor.saving')}
      </span>
    ) : autoSaveEnabled && autoSaveStatus === 'saved' && !isDirty ? (
      <span className="flex items-center gap-1 px-1 text-[color:var(--status-success)] typography-meta">
        <Icon name="check" className="size-3.5" />
        {t('filesView.editor.saved')}
      </span>
    ) : isDirty ? (
      <ToolbarTooltipButton
        label={t(autoSaveEnabled ? 'filesView.editor.saveNowTitle' : 'filesView.editor.saveNowManualTitle', { shortcut: saveShortcut })}
        icon="save-3"
        onClick={() => void saveDraft()}
      />
    ) : null;
    // A canvas or diagram saves through its own button even where text cannot be edited.
    // Save state sits after the path, which gives up the width it takes:
    // the buttons never move when it appears.
    const status = (canEdit && isTextFile) || hasCanvas || isDrawio ? statusContent : null;

    const toolbar = (
      <ActionToolbar
        className={docked ? 'flex-1' : undefined}
        start={docked ? (
          // Mobile hosts already show the file name in their own header;
          // a truncated duplicate here just eats toolbar width.
          showsPathLabel ? (
            pathLabelCopies ? (
              // The name copies the path: it brightens under the pointer and
              // a copy mark appears after it; a check answers the click.
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void copyPath(false)}
                    aria-label={copyPathLabel}
                    className="group/path flex min-w-0 flex-1 items-center text-start typography-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                  >
                    <FilePathLabel
                      path={displaySelectedPath}
                      title={null}
                      trailing={(
                        <Icon
                          name={copiedPath ? 'check' : 'file-copy'}
                          className={cn(
                            'size-3 shrink-0 transition-opacity',
                            copiedPath ? 'text-[color:var(--status-success)] opacity-100' : 'opacity-0 group-hover/path:opacity-100 group-focus-visible/path:opacity-100',
                          )}
                        />
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={copyPathLabel} /></TooltipContent>
              </Tooltip>
            ) : (
              <FilePathLabel path={displaySelectedPath} className="typography-meta text-muted-foreground" />
            )
          ) : null
        ) : undefined}
        status={status}
        inline={hasSourceEditor ? (
          // Rendered with the row, not with its button, so it still opens when
          // that button has moved into the "More actions" menu.
          <GoToLineDialog
            open={isGoToLineOpen}
            onOpenChange={setIsGoToLineOpen}
            viewRef={editorViewRef}
            variant="inline"
          />
        ) : null}
        // The row keeps what a file is read and worked with: its view mode,
        // find and a comment on it. Editor aids, the file's own actions and
        // document settings wait in "More actions", so the row stays a few
        // buttons whatever the file is.
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
