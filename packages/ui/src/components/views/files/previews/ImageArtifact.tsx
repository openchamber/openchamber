import React from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactDimensions, formatArtifactSize } from './artifactMeta';

type ImageZoom = 'fit' | 'actual';

/**
 * An image the way a designer looks at one: whole first, then at 1:1 to check
 * pixels. Fit never upscales, so a small icon stays its real size instead of
 * blurring across the panel.
 */
export const ImageArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
}> = ({ src, name, sizeBytes }) => {
  const { t } = useI18n();
  const [zoom, setZoom] = React.useState<ImageZoom>('fit');
  const [natural, setNatural] = React.useState<{ width: number; height: number } | null>(null);

  React.useEffect(() => {
    setNatural(null);
    setZoom('fit');
  }, [src]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[formatArtifactDimensions(natural), formatArtifactSize(sizeBytes)]}
        actions={(
          <>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={zoom === 'fit'}
              title={t('filesView.artifact.image.fitTitle')}
              onClick={() => setZoom('fit')}
            >
              {t('filesView.artifact.image.fit')}
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={zoom === 'actual'}
              title={t('filesView.artifact.image.actualTitle')}
              onClick={() => setZoom('actual')}
            >
              1:1
            </Button>
          </>
        )}
      />
      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto p-3',
          zoom === 'fit' && 'flex items-center justify-center',
        )}
      >
        <img
          key={src}
          src={src}
          alt={name}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            setNatural({ width: image.naturalWidth, height: image.naturalHeight });
          }}
          className={cn(
            'rounded-md border border-border/30 bg-primary/10',
            zoom === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none',
          )}
        />
      </div>
    </div>
  );
};
