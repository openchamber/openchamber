import React, { useId, useMemo } from 'react';
import { useReducedMotion } from 'motion/react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { useWaitingPhase } from '@/hooks/useDurationTicker';
import { OPEN_CHAMBER_LOGO_ART as ART } from './openChamberLogoArt';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
  variant?: 'default' | 'splash';
}

// The open-shell cube in one colour, the theme's text colour. The drawing is
// generated from scripts/brand, which also writes the HTML splashes that show
// before React, so the hand-off between them does not change the logo.
export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
  variant = 'default',
}) => {
  const { t } = useI18n();
  const themeContext = useOptionalThemeSystem();
  const gradientId = useId();
  const reducedMotion = useReducedMotion();
  // While loading, the roof tiers light up one at a time, one step a second
  // on the shared clock.
  const animated = isAnimated && !reducedMotion;
  const litTier = useWaitingPhase(animated, ART.tiers.length);

  const color = useMemo(() => {
    // Startup stages share the pre-paint palette while the app theme hydrates.
    if (variant === 'splash') {
      return 'var(--splash-stroke, var(--surface-foreground))';
    }
    if (themeContext) {
      return themeContext.currentTheme.colors.surface.foreground;
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-stroke').trim();
      if (fromVars) {
        return fromVars;
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'white' : 'black';
    }
    return 'white';
  }, [themeContext, variant]);

  const tierOpacity = (index: number) => {
    if (!animated) return ART.tierOpacity[index];
    return index === litTier ? ART.tierLit[index] : ART.tierRest[index];
  };

  return (
    <svg
      width={width}
      height={height}
      viewBox="-50 -50 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={t('openChamberLogo.aria.logo')}
    >
      <defs>
        {ART.walls.map(({ gradient }, index) => (
          <linearGradient
            key={index}
            id={`${gradientId}-wall-${index}`}
            gradientUnits="userSpaceOnUse"
            x1={gradient.x1}
            y1={gradient.y1}
            x2={gradient.x2}
            y2={gradient.y2}
          >
            {gradient.stops.map(([offset, opacity]) => (
              <stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {ART.walls.map(({ path }, index) => (
        <path key={index} d={path} fill={`url(#${gradientId}-wall-${index})`} />
      ))}
      <path d={ART.roof} fill={color} fillOpacity={ART.roofOpacity} />
      {ART.tiers.map((path, index) => (
        <path key={index} d={path} fill={color} fillOpacity={tierOpacity(index)} />
      ))}
      <g fill="none" stroke={color} strokeWidth={ART.stroke} strokeLinejoin="round" strokeLinecap="round">
        {ART.shell.map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
    </svg>
  );
};
