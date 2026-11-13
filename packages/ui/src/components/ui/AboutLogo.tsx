import React from 'react';
import { useReducedMotion } from 'motion/react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { LevitatingLogo } from '@/components/ui/LevitatingLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';

// Seven quick taps on the logo, the way a phone's build number unlocks developer options.
const TAPS_TO_LEVITATE = 7;
const TAP_GAP_MS = 700;

/** The logo of the About surfaces (the dialog and the Settings page), with its seven-tap levitation. */
export const AboutLogo: React.FC<{ size?: number }> = ({ size = 64 }) => {
  const { currentTheme } = useThemeSystem();
  const reducedMotion = useReducedMotion();
  const [levitating, setLevitating] = React.useState(false);
  const tapsRef = React.useRef({ count: 0, at: 0 });
  const stopLevitating = React.useCallback(() => setLevitating(false), []);

  const handleTap = () => {
    if (levitating || reducedMotion) return;
    const now = performance.now();
    const count = now - tapsRef.current.at < TAP_GAP_MS ? tapsRef.current.count + 1 : 1;
    tapsRef.current = { count: count >= TAPS_TO_LEVITATE ? 0 : count, at: now };
    if (count >= TAPS_TO_LEVITATE) setLevitating(true);
  };

  return (
    <div className="relative select-none" onClick={handleTap}>
      <OpenChamberLogo width={size} height={size} className={levitating ? 'invisible' : undefined} />
      {levitating ? (
        <LevitatingLogo size={size} color={currentTheme.colors.surface.foreground} onDone={stopLevitating} />
      ) : null}
    </div>
  );
};
