import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ContentState } from '@/components/ui/content-state';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';
import { useI18n } from '@/lib/i18n';

export function renderFileHtmlUnavailable({ tabs, viewModes, t }: {
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'htmlViewModeByPathRef' | 'setHtmlViewMode'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { selectedFile } = tabs;
  const { htmlViewModeByPathRef, setHtmlViewMode } = viewModes;
  if (!selectedFile) return null;
  return (
            <ContentState
              icon={<FileTypeIcon filePath={selectedFile.path} className="size-10" />}
              title={t('filesView.editor.htmlPreviewRelayUnavailable')}
              actions={(
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        htmlViewModeByPathRef.current[selectedFile.path] = 'edit';
                        setHtmlViewMode('edit');
                      }}
                    >
                      {t('filesView.editor.htmlPreviewShowCode')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{t('contextTooltips.files.showCodeForFile')}</TooltipContent>
                </Tooltip>
              )}
            />
  );
}
