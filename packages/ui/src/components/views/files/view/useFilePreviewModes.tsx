import React from 'react';
import { toast } from '@/components/ui';
import { DiagramEditor } from '@/components/diagram';
import { EMPTY_CANVAS_READ } from '@/components/views/files/fileCanvas';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { type TextViewMode, type PreviewViewMode } from './fileViewTypes';
import { isDrawioFile } from '@/lib/toolHelpers';
import { isFilePathMoveInFlight } from '@/lib/filePathMoves';
import { isMarkdownFile, opensInFileCanvas, isHtmlFile } from './fileViewKinds';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileKinds } from './useFileKinds';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileDocument } from './useFileDocument';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';

type DiagramEditorRef = React.RefObject<React.ComponentRef<typeof DiagramEditor> | null>;

export function useFileViewModes() {
  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<'tree' | 'text'>('tree');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('preview');
  const [canvasViewMode, setCanvasViewMode] = React.useState<PreviewViewMode>('preview');
  const [svgViewMode, setSvgViewMode] = React.useState<PreviewViewMode>('preview');
  const [mermaidViewMode, setMermaidViewMode] = React.useState<PreviewViewMode>('preview');
  const [tableViewMode, setTableViewMode] = React.useState<'table' | 'text'>('table');
  const textViewModeByPathRef = React.useRef<Record<string, TextViewMode>>({});
  const mdViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const htmlViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const svgViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const mermaidViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const tableViewModeByPathRef = React.useRef<Record<string, 'table' | 'text'>>({});
  const drawioViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const canvasViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);

  return { textViewMode, setTextViewMode, mdViewMode, setMdViewMode, jsonViewMode, setJsonViewMode, htmlViewMode, setHtmlViewMode, drawioViewMode, setDrawioViewMode, canvasViewMode, setCanvasViewMode, svgViewMode, setSvgViewMode, mermaidViewMode, setMermaidViewMode, tableViewMode, setTableViewMode, textViewModeByPathRef, mdViewModeByPathRef, htmlViewModeByPathRef, svgViewModeByPathRef, mermaidViewModeByPathRef, tableViewModeByPathRef, drawioViewModeByPathRef, canvasViewModeByPathRef, settingsDefaultFileViewerPreview };
}

export function useFileDiagram() {
  const [drawioRemountNonce, setDrawioRemountNonce] = React.useState(0);
  const diagramAutoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramXmlRef = React.useRef('');
  const diagramSavedXmlRef = React.useRef('');
  const pendingDrawioPreviewFrameRef = React.useRef<number | null>(null);
  const pendingCanvasPreviewFrameRef = React.useRef<number | null>(null);
  const diagramEditorRef: DiagramEditorRef = React.useRef<React.ComponentRef<typeof DiagramEditor>>(null);
  const [diagramSaved, setDiagramSaved] = React.useState(false);

  return { drawioRemountNonce, setDrawioRemountNonce, diagramAutoSaveTimerRef, diagramXmlRef, diagramSavedXmlRef, pendingDrawioPreviewFrameRef, pendingCanvasPreviewFrameRef, diagramEditorRef, diagramSaved, setDiagramSaved };
}

export function useFilePreviewModes({ canvasState, diagram, draft, fileDocument, fileKinds, fileSaving, markdownPreview, scope, tabs, viewModes, files, isMobile, t }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'canvasDirtyRef' | 'canvasEditorRef' | 'setCanvasDirty' | 'setCanvasRemountNonce'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramAutoSaveTimerRef' | 'diagramSavedXmlRef' | 'diagramXmlRef' | 'pendingCanvasPreviewFrameRef' | 'pendingDrawioPreviewFrameRef' | 'setDiagramSaved' | 'setDrawioRemountNonce'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'autoSaveEnabled' | 'draftContent' | 'setDraftContent'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent' | 'fileContentRevision' | 'fileLoading' | 'lastLoadedFileStatRef' | 'loadedFilePath' | 'pendingPathMoveRef' | 'setArtifactSize'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit' | 'canMountCanvas' | 'guestFileEditor' | 'isDrawio' | 'isMarkdown'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'AUTO_SAVE_DELAY' | 'applyLoadedTextContent' | 'readFileStat'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'focusMdPreviewContainer'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'openPaths' | 'selectedFile' | 'selectedFilePathRef'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'canvasViewModeByPathRef' | 'drawioViewMode' | 'drawioViewModeByPathRef' | 'htmlViewMode' | 'htmlViewModeByPathRef' | 'mdViewMode' | 'mdViewModeByPathRef' | 'mermaidViewModeByPathRef' | 'setCanvasViewMode' | 'setDrawioViewMode' | 'setHtmlViewMode' | 'setJsonViewMode' | 'setMdViewMode' | 'setMermaidViewMode' | 'setSvgViewMode' | 'setTableViewMode' | 'setTextViewMode' | 'settingsDefaultFileViewerPreview' | 'svgViewModeByPathRef' | 'tableViewModeByPathRef' | 'textViewMode' | 'textViewModeByPathRef'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { canvasDirtyRef, canvasEditorRef, setCanvasDirty, setCanvasRemountNonce } = canvasState;
  const { diagramAutoSaveTimerRef, diagramSavedXmlRef, diagramXmlRef, pendingCanvasPreviewFrameRef, pendingDrawioPreviewFrameRef, setDiagramSaved, setDrawioRemountNonce } = diagram;
  const { autoSaveEnabled, draftContent, setDraftContent } = draft;
  const { fileContent, fileContentRevision, fileLoading, lastLoadedFileStatRef, loadedFilePath, pendingPathMoveRef, setArtifactSize } = fileDocument;
  const { canEdit, canMountCanvas, guestFileEditor, isDrawio, isMarkdown } = fileKinds;
  const { AUTO_SAVE_DELAY, applyLoadedTextContent, readFileStat } = fileSaving;
  const { focusMdPreviewContainer } = markdownPreview;
  const { root } = scope;
  const { openPaths, selectedFile, selectedFilePathRef } = tabs;
  const { canvasViewMode, canvasViewModeByPathRef, drawioViewMode, drawioViewModeByPathRef, htmlViewMode, htmlViewModeByPathRef, mdViewMode, mdViewModeByPathRef, mermaidViewModeByPathRef, setCanvasViewMode, setDrawioViewMode, setHtmlViewMode, setJsonViewMode, setMdViewMode, setMermaidViewMode, setSvgViewMode, setTableViewMode, setTextViewMode, settingsDefaultFileViewerPreview, svgViewModeByPathRef, tableViewModeByPathRef, textViewMode, textViewModeByPathRef } = viewModes;

  React.useEffect(() => {
    if (!canEdit && textViewMode === 'edit') {
      setTextViewMode('view');
    }
  }, [canEdit, textViewMode]);

  const MD_VIEWER_MODE_KEY = 'openchamber:files:md-viewer-mode';
  const HTML_VIEWER_MODE_KEY = 'openchamber:files:html-viewer-mode';
  const JSON_VIEWER_MODE_KEY = 'openchamber:files:json-viewer-mode';

  React.useEffect(() => {
    const selectedPath = selectedFile?.path;
    if (!selectedPath) {
      return;
    }

    setTextViewMode(textViewModeByPathRef.current[selectedPath] ?? 'edit');

    let mdDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        mdDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setMdViewMode(mdViewModeByPathRef.current[selectedPath] ?? mdDefault);

    let htmlDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(HTML_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        htmlDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setHtmlViewMode(htmlViewModeByPathRef.current[selectedPath] ?? htmlDefault);
    setDrawioViewMode(drawioViewModeByPathRef.current[selectedPath] ?? (settingsDefaultFileViewerPreview ? 'preview' : 'edit'));
    setCanvasViewMode(canvasViewModeByPathRef.current[selectedPath] ?? 'preview');
    setSvgViewMode(svgViewModeByPathRef.current[selectedPath] ?? 'preview');
    setMermaidViewMode(mermaidViewModeByPathRef.current[selectedPath] ?? 'preview');
    setTableViewMode(tableViewModeByPathRef.current[selectedPath] ?? 'table');

    let jsonDefault: 'tree' | 'text' = settingsDefaultFileViewerPreview ? 'tree' : 'text';
    try {
      const stored = localStorage.getItem(JSON_VIEWER_MODE_KEY);
      if (stored === 'tree' || stored === 'text') {
        jsonDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setJsonViewMode(jsonDefault);
  }, [selectedFile?.path, settingsDefaultFileViewerPreview]);

  const saveTextViewMode = React.useCallback((mode: TextViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      textViewModeByPathRef.current[selectedPath] = mode;
    }
    setTextViewMode(mode);
  }, [selectedFile?.path]);

  const saveMdViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      mdViewModeByPathRef.current[selectedPath] = mode;
    }
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const getMdViewMode = React.useCallback((): PreviewViewMode => {
    return mdViewMode;
  }, [mdViewMode]);

  const saveSvgViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) svgViewModeByPathRef.current[selectedPath] = mode;
    setSvgViewMode(mode);
  }, [selectedFile?.path]);

  const saveMermaidViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) mermaidViewModeByPathRef.current[selectedPath] = mode;
    setMermaidViewMode(mode);
  }, [selectedFile?.path]);

  const saveTableViewMode = React.useCallback((mode: 'table' | 'text') => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) tableViewModeByPathRef.current[selectedPath] = mode;
    setTableViewMode(mode);
  }, [selectedFile?.path]);

  React.useEffect(() => {
    const selectedPath = selectedFile?.path;
    setArtifactSize(null);
    if (!selectedPath || loadedFilePath !== selectedPath) return;
    let cancelled = false;
    void readFileStat(selectedPath)
      .then((stat) => {
        if (!cancelled && stat) setArtifactSize(stat.size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fileContentRevision, loadedFilePath, readFileStat, selectedFile?.path]);

  const mdPreviewFocusTargetPath = selectedFile && isMarkdown && getMdViewMode() === 'preview' && !fileLoading
    ? selectedFile.path
    : null;
  React.useEffect(() => {
    if (!mdPreviewFocusTargetPath || isMobile) return;
    focusMdPreviewContainer();
  }, [focusMdPreviewContainer, isMobile, mdPreviewFocusTargetPath]);

  const saveJsonViewMode = React.useCallback((mode: 'tree' | 'text') => {
    setJsonViewMode(mode);
    try {
      localStorage.setItem(JSON_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const saveHtmlViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      htmlViewModeByPathRef.current[selectedPath] = mode;
    }
    setHtmlViewMode(mode);
    try {
      localStorage.setItem(HTML_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const saveDrawioViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      drawioViewModeByPathRef.current[selectedPath] = mode;
    }
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    if (pendingDrawioPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
      pendingDrawioPreviewFrameRef.current = null;
    }
    if (mode === 'edit') {
      setDraftContent(diagramXmlRef.current || fileContent);
      setDrawioViewMode(mode);
    } else {
      diagramXmlRef.current = draftContent;
      const pathAtToggle = selectedPath;
      setDrawioViewMode('edit');
      pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
        pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
          pendingDrawioPreviewFrameRef.current = null;
          if (root && pathAtToggle && useFilesViewTabsStore.getState().byRoot[root]?.selectedPath !== pathAtToggle) {
            return;
          }
          setDrawioRemountNonce((value) => value + 1);
          setDrawioViewMode('preview');
        });
      });
      return;
    }
  }, [draftContent, fileContent, root, selectedFile?.path]);

  const saveCanvasViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    const rememberMode = () => {
      if (selectedPath) canvasViewModeByPathRef.current[selectedPath] = mode;
    };
    if (mode === 'edit') {
      if (!canvasDirtyRef.current) {
        rememberMode();
        setCanvasDirty(false);
        setCanvasViewMode(mode);
        return;
      }
      void Promise.resolve(canvasEditorRef.current?.getContent('handoff') ?? EMPTY_CANVAS_READ).then((read) => {
        if (selectedFilePathRef.current !== selectedPath) return;
        if (!read.ok) {
          toast.error(read.message);
          return;
        }
        rememberMode();
        setDraftContent(read.snapshot && 'content' in read.snapshot ? read.snapshot.content : fileContent);
        setCanvasDirty(false);
        setCanvasViewMode(mode);
      });
      return;
    }
    if (!canMountCanvas) {
      if (guestFileEditor) toast.error(t('filesView.fileEditor.tooLarge', { editor: guestFileEditor.editor.title }));
      return;
    }
    rememberMode();
    setCanvasDirty(false);
    const pathAtToggle = selectedPath;
    if (pendingCanvasPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pendingCanvasPreviewFrameRef.current);
    }
    pendingCanvasPreviewFrameRef.current = requestAnimationFrame(() => {
      pendingCanvasPreviewFrameRef.current = null;
      if (root && pathAtToggle && useFilesViewTabsStore.getState().byRoot[root]?.selectedPath !== pathAtToggle) {
        return;
      }
      setCanvasRemountNonce((value) => value + 1);
      setCanvasViewMode('preview');
    });
  }, [canMountCanvas, fileContent, guestFileEditor, root, selectedFile?.path, t]);

  const saveDiagramXml = React.useCallback(async (path: string, xml: string) => {
    if (!files.writeFile || xml === diagramSavedXmlRef.current) {
      return false;
    }
    if (pendingPathMoveRef.current || isFilePathMoveInFlight(path)) {
      return false;
    }

    const result = await files.writeFile(path, xml);
    if (!result?.success) {
      toast.error(t('filesView.toast.writeFileFailed'));
      return false;
    }

    applyLoadedTextContent(xml);
    const stat = await readFileStat(path).catch(() => null);
    if (stat) {
      lastLoadedFileStatRef.current = stat;
    }
    return true;
  }, [applyLoadedTextContent, files, readFileStat, t]);

  React.useEffect(() => {
    return () => {
      if (diagramAutoSaveTimerRef.current) {
        clearTimeout(diagramAutoSaveTimerRef.current);
        diagramAutoSaveTimerRef.current = null;
      }
      if (pendingDrawioPreviewFrameRef.current !== null) {
        cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
        pendingDrawioPreviewFrameRef.current = null;
      }
    };
  }, [drawioViewMode, selectedFile?.path]);

  const handleDiagramChange = React.useCallback((xml: string) => {
    diagramXmlRef.current = xml;
    if (!autoSaveEnabled || !selectedFile?.path || drawioViewMode !== 'preview' || !files.writeFile) {
      return;
    }

    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
    }

    const path = selectedFile.path;
    diagramAutoSaveTimerRef.current = setTimeout(() => {
      diagramAutoSaveTimerRef.current = null;
      void saveDiagramXml(path, xml).then((saved) => {
        if (!saved) return;
        setDiagramSaved(true);
        setTimeout(() => setDiagramSaved(false), 1500);
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      });
    }, AUTO_SAVE_DELAY);
  }, [autoSaveEnabled, drawioViewMode, files.writeFile, saveDiagramXml, selectedFile?.path, t]);

  const diagramEditorXml = React.useMemo(() => {
    if (!isDrawio) {
      return fileContent;
    }
    return diagramXmlRef.current || draftContent || fileContent;
  }, [draftContent, fileContent, isDrawio]);

  const handleCanvasUnsupported = React.useCallback(() => {
    const path = selectedFilePathRef.current;
    if (path) {
      canvasViewModeByPathRef.current[path] = 'edit';
    }
    setCanvasDirty(false);
    setCanvasViewMode('edit');
    if (guestFileEditor) toast.error(t('filesView.fileEditor.unsupported', { editor: guestFileEditor.editor.title }));
  }, [guestFileEditor, t]);

  React.useEffect(() => {
    return () => {
      if (pendingCanvasPreviewFrameRef.current !== null) {
        cancelAnimationFrame(pendingCanvasPreviewFrameRef.current);
        pendingCanvasPreviewFrameRef.current = null;
      }
    };
  }, [canvasViewMode, selectedFile?.path]);

  const getHtmlViewMode = React.useCallback((): PreviewViewMode => {
    return htmlViewMode;
  }, [htmlViewMode]);

  React.useEffect(() => {
    const applyDefaultFileViewerMode = (enabled: boolean) => {
      const previewMode: PreviewViewMode = enabled ? 'preview' : 'edit';
      const nextJsonMode: 'tree' | 'text' = enabled ? 'tree' : 'text';

      for (const path of openPaths) {
        textViewModeByPathRef.current[path] = 'edit';
        if (isMarkdownFile(path)) {
          mdViewModeByPathRef.current[path] = previewMode;
        }
        if (isHtmlFile(path)) {
          htmlViewModeByPathRef.current[path] = previewMode;
        }
        if (isDrawioFile(path)) {
          drawioViewModeByPathRef.current[path] = previewMode;
        }
        if (opensInFileCanvas(path)) {
          canvasViewModeByPathRef.current[path] = previewMode;
        }
      }

      setTextViewMode('edit');
      setMdViewMode(previewMode);
      setHtmlViewMode(previewMode);
      setDrawioViewMode(previewMode);
      setCanvasViewMode(previewMode);
      setJsonViewMode(nextJsonMode);

      try {
        localStorage.setItem(MD_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(HTML_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(JSON_VIEWER_MODE_KEY, nextJsonMode);
      } catch {
        // Ignore localStorage errors
      }
    };

    const handleFileViewerModeChanged = (event: Event) => {
      const enabled = Boolean((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled);
      applyDefaultFileViewerMode(enabled);
    };

    window.addEventListener('openchamber:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    return () => {
      window.removeEventListener('openchamber:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    };
  }, [openPaths]);
  return {
  saveTextViewMode, saveMdViewMode, getMdViewMode, saveSvgViewMode, saveMermaidViewMode, saveTableViewMode,
  saveJsonViewMode, saveHtmlViewMode, saveDrawioViewMode, saveCanvasViewMode, saveDiagramXml, handleDiagramChange,
  diagramEditorXml, handleCanvasUnsupported, getHtmlViewMode,
  };
}
