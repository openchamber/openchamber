import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { type useFileKinds } from './useFileKinds';
import { type useFileCanvas } from './useFileCanvas';
import { useI18n } from '@/lib/i18n';

export function renderFileExtensionNotice({ fileCanvas, fileKinds, t }: {
  fileCanvas: Pick<ReturnType<typeof useFileCanvas>, 'openExcalidrawExtensionCard'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'suggestExcalidrawExtension'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { openExcalidrawExtensionCard } = fileCanvas;
  const { suggestExcalidrawExtension } = fileKinds;
  return (
suggestExcalidrawExtension ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge-muted bg-[var(--surface-muted)] px-3 py-1.5 typography-ui text-muted-foreground">
          <Icon name="information" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('filesView.excalidraw.installHint')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="xs" variant="outline" onClick={openExcalidrawExtensionCard}>
                {t('filesView.excalidraw.installAction')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.files.excalidrawSettings')}</TooltipContent>
          </Tooltip>
        </div>
      ) : null
  );
}
