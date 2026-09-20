import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { OpenChamberLogo } from './OpenChamberLogo';

// Mount only alongside the real app shell. Earlier auth/connection loaders
// hand off without fading; this is the single reveal of the interactive UI.
export const AppStartupOverlay: React.FC<{ ready: boolean; animated?: boolean }> = ({ ready, animated = false }) => {
  const [dismissed, setDismissed] = React.useState(false);
  const reducedMotion = useReducedMotion();

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
    </motion.div>
  );
};
