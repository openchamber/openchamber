import * as React from 'react';

import { cn } from '@/lib/utils';
import '@/styles/fireworks.css';

const PARTICLE_COUNT = 12;

const DEFAULT_BURSTS = [
  { id: 'left', x: 22, y: 58, delay: 0, radius: 120, colorVar: '--status-success' },
  { id: 'center', x: 50, y: 42, delay: 120, radius: 150, colorVar: '--primary-base' },
  { id: 'right', x: 78, y: 55, delay: 200, radius: 130, colorVar: '--status-info' },
];

interface FireworksAnimationProps {
  isActive: boolean;
  burstKey?: number;
  className?: string;
  durationMs?: number;
  bursts?: typeof DEFAULT_BURSTS;
  onComplete?: () => void;
}

export const FireworksAnimation: React.FC<FireworksAnimationProps> = ({
  isActive,
  burstKey = 0,
  className,
  durationMs = 900,
  bursts = DEFAULT_BURSTS,
  onComplete,
}) => {
  const hasRenderedRef = React.useRef(false);

  React.useEffect(() => {
    if (!isActive && hasRenderedRef.current) {
      onComplete?.();
    }
    if (isActive) {
      hasRenderedRef.current = true;
    }
  }, [isActive, onComplete]);

  const particleVectors = React.useMemo(() => {
    return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
      const angle = (Math.PI * 2 * index) / PARTICLE_COUNT;
      return {
        x: Math.cos(angle),
        y: Math.sin(angle),
        delay: index * 18,
      };
    });
  }, []);

  if (!isActive) {
    return null;
  }

  return (
    <div
      className={cn('fireworks-overlay pointer-events-none', className)}
      aria-hidden="true"
      data-burst-key={burstKey}
    >
      {bursts.map((burst) => {
        const burstStyle: React.CSSProperties & {
          '--burst-delay'?: string;
          '--burst-x'?: string;
          '--burst-y'?: string;
          '--firework-color'?: string;
          '--firework-duration'?: string;
        } = {
          '--burst-delay': `${burst.delay}ms`,
          '--burst-x': `${burst.x}%`,
          '--burst-y': `${burst.y}%`,
          '--firework-color': `var(${burst.colorVar})`,
          '--firework-duration': `${durationMs}ms`,
        };

        return (
          <div key={`${burst.id}-${burstKey}`} className="firework-burst" style={burstStyle}>
            {particleVectors.map((vector, index) => {
              const translateX = vector.x * burst.radius;
              const translateY = vector.y * burst.radius;
              const particleStyle: React.CSSProperties & {
                '--translate-x'?: string;
                '--translate-y'?: string;
                '--particle-delay'?: string;
              } = {
                '--translate-x': `${translateX}px`,
                '--translate-y': `${translateY}px`,
                '--particle-delay': `${vector.delay}ms`,
                color: `var(${burst.colorVar})`,
              };

              return <span key={`${burst.id}-${index}-${burstKey}`} className="firework-particle" style={particleStyle} />;
            })}
          </div>
        );
      })}
    </div>
  );
};
