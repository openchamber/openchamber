import { type ToolbarAction } from '@/components/ui/action-toolbar';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileViewModes } from './useFilePreviewModes';
import { useI18n } from '@/lib/i18n';

export function buildFileModeActions({ fileKinds, filePreviewModes, viewModes, t }: {
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'binaryCanvas' | 'canEdit' | 'canUseShikiFileView' | 'hasCanvas' | 'isDrawio' | 'isHtml' | 'isJson' | 'isMarkdown' | 'isMermaid' | 'isNotebook' | 'isSelectedSvg' | 'isTableView' | 'isTextFile' | 'sourceEditorShown'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'getHtmlViewMode' | 'getMdViewMode' | 'saveCanvasViewMode' | 'saveDrawioViewMode' | 'saveHtmlViewMode' | 'saveJsonViewMode' | 'saveMdViewMode' | 'saveMermaidViewMode' | 'saveSvgViewMode' | 'saveTableViewMode' | 'saveTextViewMode'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'drawioViewMode' | 'jsonViewMode' | 'mermaidViewMode' | 'svgViewMode' | 'tableViewMode' | 'textViewMode'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { binaryCanvas, canEdit, canUseShikiFileView, hasCanvas, isDrawio, isHtml, isJson, isMarkdown, isMermaid, isNotebook, isSelectedSvg, isTableView, isTextFile, sourceEditorShown } = fileKinds;
  const { getHtmlViewMode, getMdViewMode, saveCanvasViewMode, saveDrawioViewMode, saveHtmlViewMode, saveJsonViewMode, saveMdViewMode, saveMermaidViewMode, saveSvgViewMode, saveTableViewMode, saveTextViewMode } = filePreviewModes;
  const { canvasViewMode, drawioViewMode, jsonViewMode, mermaidViewMode, svgViewMode, tableViewMode, textViewMode } = viewModes;
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

  return { hasSourceEditor, mdPreview, openSourceEditor, modeAction };
}
