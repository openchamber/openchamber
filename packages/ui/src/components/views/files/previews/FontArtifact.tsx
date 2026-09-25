import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

const SAMPLE_SIZES = [48, 32, 24, 18, 14] as const;
const GLYPH_ROWS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789 .,;:!?&@#%()[]{}<>+-=/\\*"\'',
] as const;

let fontFamilyCounter = 0;

/**
 * A type specimen. The font is registered under a throwaway family name for
 * as long as the file is open, so nothing else in the app can accidentally
 * pick it up, and it is removed again when the tab closes.
 */
export const FontArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
}> = ({ src, name, sizeBytes }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [family] = React.useState(() => {
    fontFamilyCounter += 1;
    return `oc-font-preview-${fontFamilyCounter}`;
  });

  React.useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const face = new FontFace(family, `url("${src.replace(/"/g, '%22')}")`);
    document.fonts.add(face);
    face.load()
      .then(() => { if (!cancelled) setStatus('ready'); })
      .catch(() => { if (!cancelled) setStatus('failed'); });
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [family, src]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[name, formatArtifactSize(sizeBytes)]} />
      {status === 'failed' ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center typography-ui text-muted-foreground">
          {t('filesView.artifact.font.loadFailed')}
        </div>
      ) : status === 'loading' ? (
        <div className="flex items-center gap-2 p-3 typography-ui text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4" style={{ fontFamily: `"${family}"` }}>
          <div className="flex flex-col gap-4">
            {SAMPLE_SIZES.map((size) => (
              <div key={size} className="flex items-baseline gap-3">
                <span className="w-8 shrink-0 text-right font-sans typography-meta text-muted-foreground">{size}</span>
                <span className="min-w-0 break-words leading-tight text-foreground" style={{ fontSize: `${size}px` }}>
                  {t('filesView.artifact.font.sample')}
                </span>
              </div>
            ))}
            <div className="mt-2 flex flex-col gap-1 border-t border-border/40 pt-4 text-foreground" style={{ fontSize: '20px' }}>
              {GLYPH_ROWS.map((row) => <div key={row} className="break-all leading-relaxed">{row}</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
