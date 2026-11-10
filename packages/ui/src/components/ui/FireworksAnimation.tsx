import * as React from 'react';

import { holidayOrnamentScale, type FireworksBurst, type FireworksShow } from './fireworksShows';
import { HolidayOrnamentIcon, type HolidayOrnament } from './holidayOrnaments';
import '@/styles/fireworks.css';

// New Year: a salute of streaks with glowing heads that droop as they fade.
const SALUTE_COUNT = 12;
const SALUTE_DURATION_MS = 1300;

// Every day: paper confetti thrown up and out, tumbling as it falls.
const CONFETTI_COUNT = 22;
const CONFETTI_DURATION_MS = 1900;
const CONFETTI_CUTS = [
  { width: 11, height: 5 },
  { width: 7, height: 7 },
  { width: 14, height: 4 },
  { width: 9, height: 5 },
] as const;

// Halloween: a few ghosts float up and out of each burst while candy flies
// in every direction and drops.
const GHOST_ANGLES = [-155, -115, -65, -25].map((degrees) => (degrees * Math.PI) / 180);
const CANDY_COUNT = 6;
const GHOST_DURATION_MS = 1900;
const CANDY_DURATION_MS = 1300;

// Other holidays: drawn things thrown like confetti, turning slower so they stay readable.
const HOLIDAY_COUNT = 18;
const HOLIDAY_DURATION_MS = 2100;

type BurstStyle = React.CSSProperties & Record<`--${string}`, string>;

const ringVectors = (count: number, step: number) => Array.from({ length: count }, (_, index) => {
  const angle = (Math.PI * 2 * index) / count;
  return { x: Math.cos(angle), y: Math.sin(angle), delay: index * step };
});

const SALUTE_VECTORS = ringVectors(SALUTE_COUNT, 18);

// A fixed spread per piece, so every throw looks alike and nothing re-rolls on render.
const noise = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const CONFETTI_PIECES = Array.from({ length: CONFETTI_COUNT }, (_, index) => {
  // Mostly upward: within 145 degrees either side of straight up.
  const angle = -Math.PI / 2 + (noise(index + 1) - 0.5) * Math.PI * 1.6;
  const speed = 0.55 + noise(index + 7) * 0.6;
  return {
    x: Math.cos(angle) * speed,
    y: Math.sin(angle) * speed,
    cut: CONFETTI_CUTS[index % CONFETTI_CUTS.length],
    spin: Math.round((noise(index + 13) - 0.5) * 720),
    flip: Math.round(360 + noise(index + 19) * 540),
    fall: Math.round(140 + noise(index + 23) * 120),
    drift: Math.round((noise(index + 29) - 0.5) * 60),
    delay: Math.floor(noise(index + 31) * 90),
  };
});
const CANDY_VECTORS = ringVectors(CANDY_COUNT, 40);

const HOLIDAY_PIECES = Array.from({ length: HOLIDAY_COUNT }, (_, index) => {
  const angle = -Math.PI / 2 + (noise(index + 1) - 0.5) * Math.PI * 1.6;
  const speed = 0.55 + noise(index + 7) * 0.6;
  return {
    x: Math.cos(angle) * speed,
    y: Math.sin(angle) * speed,
    size: Math.round(12 + noise(index + 3) * 8),
    spin: Math.round((noise(index + 13) - 0.5) * 360),
    flip: Math.round(noise(index + 19) * 360),
    fall: Math.round(140 + noise(index + 23) * 120),
    drift: Math.round((noise(index + 29) - 0.5) * 60),
    delay: Math.floor(noise(index + 31) * 90),
  };
});

const particleStyle = (x: number, y: number, delay: number, extra: BurstStyle = {}): BurstStyle => ({
  '--translate-x': `${x}px`,
  '--translate-y': `${y}px`,
  '--particle-delay': `${delay}ms`,
  ...extra,
});

// A waving sheet ghost, drawn in line art like the logo.
const GhostIcon = () => (
  <svg viewBox="14 5 88 97" aria-hidden="true">
    <path
      className="firework-ghost-body"
      d="M35.8 29C39 20 46 8.5 57 8.5C67.4 8.5 76.4 18 75.8 33L76 30.5C80.5 28.8 83 23 88.5 22C95 20 98 33 83 45C79 49 75 53 73 57C71.5 68.8 66 72 55.6 77C50 80.6 46.5 87.5 44 90.5C41 91.5 40 86 42.2 82C37 86 32 91 32.6 96C33 99.5 30 99.5 28 98.5C22 95 19 86 25 77C29 71 28 70 22 69C17 68 16 66.5 19 63.5C23 59.5 29 57 30 55C30 45 21 39 19 30C17 22 20 18.5 23.5 18.5C25 18.5 26 19 27 20.5C30 24 32.5 28.8 35.8 29Z"
    />
    <path className="firework-ghost-fold" d="M34.7 40.3C34 47 32.5 51.5 29.9 55M74.6 43.4C73.8 48 73.4 53 73 57M45.6 51.4C44.5 59 41.5 65 37 70.8M64.2 54.9C64 59.5 62 63.5 59.2 67.4" />
    <ellipse className="firework-ghost-face" cx="51" cy="24.3" rx="3.4" ry="4.8" transform="rotate(20 51 24.3)" />
    <ellipse className="firework-ghost-face" cx="65.3" cy="25.8" rx="3.5" ry="4.9" />
  </svg>
);

// A wrapped sweet: a striped body between two twisted ends.
const CandyIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path className="firework-candy-wrapper" d="M7.6 10.2 3.4 7.4C2.6 9.5 2.6 14.5 3.4 16.6L7.6 13.8ZM16.4 10.2 20.6 7.4C21.4 9.5 21.4 14.5 20.6 16.6L16.4 13.8Z" />
    <ellipse cx="12" cy="12" rx="5" ry="4.2" />
    <path className="firework-candy-stripe" d="M9.6 8.3 8.8 15.4M13 7.9 11.8 16.1M15.8 9.2 15 14.8" />
  </svg>
);

const SaluteBurst = ({ burst }: { burst: FireworksBurst }) => (
  <>
    {SALUTE_VECTORS.map((vector, index) => (
      <span
        key={index}
        className="firework-streak"
        style={particleStyle(vector.x * burst.radius, vector.y * burst.radius, vector.delay, {
          '--angle': `${Math.round((Math.atan2(vector.y, vector.x) * 180) / Math.PI)}deg`,
        })}
      />
    ))}
  </>
);

const ConfettiBurst = ({ burst, palette }: { burst: FireworksBurst; palette: readonly string[] }) => {
  const offset = Math.max(0, palette.indexOf(burst.colorVar));
  return (
    <>
      {CONFETTI_PIECES.map((piece, index) => (
        <span
          key={index}
          className="firework-confetti"
          style={particleStyle(piece.x * burst.radius, piece.y * burst.radius, piece.delay, {
            '--piece-color': `var(${palette[(index + offset) % palette.length]})`,
            '--piece-width': `${piece.cut.width}px`,
            '--piece-height': `${piece.cut.height}px`,
            '--spin': `${piece.spin}deg`,
            '--flip': `${piece.flip}deg`,
            '--fall': `${piece.fall}px`,
            '--drift': `${piece.drift}px`,
          })}
        />
      ))}
    </>
  );
};

const HolidayBurst = ({ burst, ornaments, burstIndex }: { burst: FireworksBurst; ornaments: readonly HolidayOrnament[]; burstIndex: number }) => (
  <>
    {HOLIDAY_PIECES.map((piece, index) => {
      const ornament = ornaments[index % ornaments.length];
      return (
        <span
          key={index}
          className="firework-holiday"
          style={particleStyle(piece.x * burst.radius, piece.y * burst.radius, piece.delay, {
            '--piece-size': `${Math.round(piece.size * holidayOrnamentScale(ornament))}px`,
            '--spin': `${piece.spin}deg`,
            '--flip': `${piece.flip}deg`,
            '--fall': `${piece.fall}px`,
            '--drift': `${piece.drift}px`,
          })}
        >
          <HolidayOrnamentIcon ornament={ornament} variant={index + burstIndex} />
        </span>
      );
    })}
  </>
);

const GhostBurst = ({ burst }: { burst: FireworksBurst }) => (
  <>
    {GHOST_ANGLES.map((angle, index) => (
      <span
        key={`ghost-${index}`}
        className="firework-ghost"
        style={particleStyle(Math.cos(angle) * burst.radius, Math.sin(angle) * burst.radius * 1.3, index * 70)}
      >
        <GhostIcon />
      </span>
    ))}
    {CANDY_VECTORS.map((vector, index) => (
      <span
        key={`candy-${index}`}
        className="firework-candy"
        style={particleStyle(vector.x * burst.radius * 0.8, vector.y * burst.radius * 0.6, vector.delay, { color: `var(${burst.colorVar})` })}
      >
        <CandyIcon />
      </span>
    ))}
  </>
);

export const FireworksAnimation: React.FC<{ isActive: boolean; burstKey: number; show: FireworksShow }> = ({
  isActive,
  burstKey,
  show,
}) => {
  if (!isActive) {
    return null;
  }

  return (
    <div className="fireworks-overlay pointer-events-none" aria-hidden="true" data-burst-key={burstKey} data-particle={show.particle}>
      {show.bursts.map((burst, burstIndex) => {
        const burstStyle: BurstStyle = {
          '--burst-delay': `${burst.delay}ms`,
          '--burst-x': `${burst.x}%`,
          '--burst-y': `${burst.y}%`,
          '--firework-color': `var(${burst.colorVar})`,
          '--salute-duration': `${SALUTE_DURATION_MS}ms`,
          '--confetti-duration': `${CONFETTI_DURATION_MS}ms`,
          '--ghost-duration': `${GHOST_DURATION_MS}ms`,
          '--candy-duration': `${CANDY_DURATION_MS}ms`,
          '--holiday-duration': `${HOLIDAY_DURATION_MS}ms`,
        };

        return (
          <div key={`${burst.id}-${burstKey}`} className="firework-burst" style={burstStyle}>
            {show.particle === 'holiday' ? <HolidayBurst burst={burst} ornaments={show.ornaments} burstIndex={burstIndex} />
              : show.particle === 'ghost' ? <GhostBurst burst={burst} />
              : show.particle === 'salute' ? <SaluteBurst burst={burst} />
                : <ConfettiBurst burst={burst} palette={show.palette} />}
          </div>
        );
      })}
    </div>
  );
};
