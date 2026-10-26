import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useI18n } from '@/lib/i18n';
import { OpenChamberLogo } from './OpenChamberLogo';

// A start that is still on the logo after this long says so, instead of
// looking frozen while the app keeps retrying underneath.
const SLOW_START_HINT_DELAY_MS = 10_000;

// Mount only alongside the real app shell. Earlier auth/connection loaders
// hand off without fading; this is the single reveal of the interactive UI.
export const AppStartupOverlay: React.FC<{ ready: boolean; animated?: boolean }> = ({ ready, animated = false }) => {
  const { t } = useI18n();
  const [dismissed, setDismissed] = React.useState(false);
  const [slow, setSlow] = React.useState(false);
  const reducedMotion = useReducedMotion();

  React.useEffect(() => {
    if (ready) return;
    // A start that begins again waits its own ten seconds. The line is not
    // cleared on ready, so it fades out together with the logo.
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_START_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  if (dismissed) return null;

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--splash-background,var(--surface-background))] text-foreground"
      initial="loading"
      animate={ready ? 'ready' : 'loading'}
      variants={{ loading: { opacity: 1 }, ready: { opacity: 0 } }}
      transition={{ duration: reducedMotion || !ready ? 0 : 0.3, ease: 'easeOut' }}
      onAnimationComplete={(definition) => {
        if (definition === 'ready' && ready) setDismissed(true);
      }}
      style={{ pointerEvents: ready ? 'none' : 'auto' }}
    >
      <OpenChamberLogo width={120} height={120} isAnimated={animated} variant="splash" />
      {/* Absolutely positioned below the (still perfectly centered) logo so
          the text never pushes it up. 50% + half the 120px logo + a gap. */}
      {slow ? (
        <p role="status" className="absolute inset-x-0 top-[calc(50%+84px)] px-6 text-center typography-small text-muted-foreground">
          {t('startup.overlay.slow')}
        </p>
      ) : null}
    </motion.div>
  );
};
