import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ImageStatus = 'loading' | 'ready' | 'failed';

export const StatusImage: React.FC<{
  src: string;
  alt: string;
  variant: 'thumbnail' | 'large';
  className?: string;
  style?: React.CSSProperties;
  imgClassName?: string;
  imgStyle?: React.CSSProperties;
  lazy?: boolean;
  onLoad?: (image: HTMLImageElement) => void;
}> = ({ src, alt, variant, className, style, imgClassName, imgStyle, lazy, onLoad }) => {
  const { t } = useI18n();
  // Kept with the URL and the attempt it belongs to: a reset in an effect on a
  // new URL would run after the load event of a fast (cached or data) image
  // and hide it again.
  const [attempt, setAttempt] = React.useState(0);
  const [settled, setSettled] = React.useState<{ key: string; status: ImageStatus } | null>(null);
  const key = `${src}:${attempt}`;
  const status: ImageStatus = settled?.key === key ? settled.status : 'loading';
  const blink = useWaitingBlink(variant === 'thumbnail' && status === 'loading');

  const retry = () => setAttempt((value) => value + 1);

  return (
    <div className={cn('relative', className)} style={style}>
      {status !== 'failed' ? (
        <img
          key={key}
          src={src}
          alt={alt}
          loading={lazy ? 'lazy' : undefined}
          className={cn(imgClassName, status === 'loading' && 'invisible')}
          style={imgStyle}
          onLoad={(event) => {
            setSettled({ key, status: 'ready' });
            onLoad?.(event.currentTarget);
          }}
          onError={() => setSettled({ key, status: 'failed' })}
        />
      ) : null}
      {variant === 'thumbnail' && status === 'loading' ? (
        <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-[var(--interactive-hover)]', blink)} />
      ) : null}
      {variant === 'thumbnail' && status === 'failed' ? (
        <span
          role="img"
          aria-label={t('common.image.loadFailed')}
          title={t('common.image.loadFailed')}
          className="absolute inset-0 flex items-center justify-center text-muted-foreground"
        >
          <Icon name="image" className="size-5" />
        </span>
      ) : null}
      {variant === 'large' && status === 'loading' ? (
        <ContentLoadingState label={t('common.image.loading')} className="pointer-events-none absolute inset-0" />
      ) : null}
      {variant === 'large' && status === 'failed' ? (
        <ContentState
          icon={<Icon name="image" className="size-10 text-muted-foreground" />}
          title={t('common.image.loadFailed')}
          actions={(
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <Icon name="refresh" className="me-2 size-4" />
              {t('common.image.retry')}
            </Button>
          )}
        />
      ) : null}
    </div>
  );
};
