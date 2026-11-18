import { type useFileSaving } from './useFileSaving';
import { type useFilePreviewModes, type useFileDiagram } from './useFilePreviewModes';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileTabs } from './useFileTabs';

export function useFileSaveButtons({ canvasState, diagram, filePreviewModes, fileSaving, tabs }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'setCanvasSaved'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramAutoSaveTimerRef' | 'diagramEditorRef' | 'setDiagramSaved'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'saveDiagramXml'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'saveDraft'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
}) {
  const { setCanvasSaved } = canvasState;
  const { diagramAutoSaveTimerRef, diagramEditorRef, setDiagramSaved } = diagram;
  const { saveDiagramXml } = filePreviewModes;
  const { saveDraft } = fileSaving;
  const { selectedFile } = tabs;
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

  return { saveCanvas, saveDiagram };
}
