import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Icon } from '@/components/icon/Icon';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileKinds } from './useFileKinds';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileDiagram, type useFileViewModes } from './useFilePreviewModes';
import { type useFileSaveButtons } from './useFileSaveButtons';
import { useI18n } from '@/lib/i18n';

export function renderFileSaveStatus({ canvasState, diagram, draft, fileKinds, fileSaving, saveButtons, viewModes, saveShortcut, t }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'canvasSaved'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramSaved'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'autoSaveEnabled' | 'autoSaveStatus' | 'isSaving'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit' | 'hasCanvas' | 'isDrawio' | 'isTextFile'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'isDirty' | 'saveDraft'>;
  saveButtons: Pick<ReturnType<typeof useFileSaveButtons>, 'saveCanvas' | 'saveDiagram'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'drawioViewMode'>;
  saveShortcut: string;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { canvasSaved } = canvasState;
  const { diagramSaved } = diagram;
  const { autoSaveEnabled, autoSaveStatus, isSaving } = draft;
  const { canEdit, hasCanvas, isDrawio, isTextFile } = fileKinds;
  const { isDirty, saveDraft } = fileSaving;
  const { saveCanvas, saveDiagram } = saveButtons;
  const { canvasViewMode, drawioViewMode } = viewModes;
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
    const status = (canEdit && isTextFile) || hasCanvas || isDrawio ? statusContent : null;

  return { status };
}
