import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ContentLoadingState } from '@/components/ui/content-state';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from '../previews/ArtifactMetaBar';
import { ImageFullscreenButton } from '../previews/ImageArtifact';
import { type useArtifactPreview } from './useArtifactPreview';
import { type useFileDocument } from './useFileDocument';
import { type useFileImageFullscreen } from './useFileImageFullscreen';
import { type useFileTabs } from './useFileTabs';

const BAR_CLASS = 'header-safe-area min-h-[var(--oc-header-height,56px)] ps-[var(--oc-titlebar-start-inset,0.75rem)] pe-[var(--oc-titlebar-end-inset,0.75rem)]';

const dockedToggle = () => document.querySelector<HTMLElement>('[data-image-fullscreen-toggle="enter"]') ?? true;

export function renderFileImageFullscreen({ artifacts, fileDocument, imageFullscreen, tabs, t }: {
  artifacts: Pick<ReturnType<typeof useArtifactPreview>, 'renderFileErrorState' | 'renderImageArtifact'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileError' | 'fileLoading'>;
  imageFullscreen: Pick<ReturnType<typeof useFileImageFullscreen>, 'closeTabTarget' | 'open' | 'setOpen'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { renderFileErrorState, renderImageArtifact } = artifacts;
  const { fileError, fileLoading } = fileDocument;
  const { closeTabTarget, open, setOpen } = imageFullscreen;
  const { selectedFile } = tabs;
  const exit = { active: true, toggle: () => setOpen(false) };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <DialogContent
        aria-label={selectedFile?.name ?? t('filesView.editor.fullscreen')}
        data-image-fullscreen=""
        showCloseButton={false}
        fullWindow
        layerClassName="p-0"
        backdropProps={{ className: 'rounded-none backdrop-blur-none' }}
        finalFocus={dockedToggle}
        className="oc-side-safe-area h-full max-h-none w-full max-w-none gap-0 overflow-hidden rounded-none p-0"
      >
        <div ref={closeTabTarget} className="flex h-full min-h-0 flex-col">
          {selectedFile && !fileLoading && !fileError ? (
            renderImageArtifact(selectedFile, { fullscreen: exit, lead: selectedFile.name, barClassName: BAR_CLASS })
          ) : (
            <>
              <ArtifactMetaBar items={[]} lead={selectedFile?.name} className={BAR_CLASS} actions={<ImageFullscreenButton {...exit} />} />
              <div className="min-h-0 flex-1">
                {!selectedFile ? null : fileError ? renderFileErrorState(selectedFile) : <ContentLoadingState label={t('filesView.artifact.state.loading')} />}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
