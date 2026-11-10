import type { Celebration } from '@/lib/easter-eggs/calendar';

import type { HolidayOrnament } from './holidayOrnaments';

/** What is being celebrated. A merge is worth more than a push, so it fires more volleys. */
export type CelebrationKind = 'push' | 'merge' | 'deletion';

export interface CelebrationOptions {
  kind?: CelebrationKind;
  /** Volleys to fire one after another; a merged stack fires one per layer. */
  volleys?: number;
  /** The button that started it: the first burst comes from there, the volleys follow. */
  origin?: HTMLElement | null;
}

/** A point on screen, in percent of the viewport. */
interface BurstOrigin {
  x: number;
  y: number;
}

export interface FireworksBurst {
  id: string;
  x: number;
  y: number;
  delay: number;
  radius: number;
  colorVar: string;
}

export interface FireworksShow {
  /**
   * Confetti every day, a firework salute at New Year, ghosts tossing candy on
   * Halloween, drawn things (hearts, flags, leaves) on the other holidays.
   */
  particle: 'confetti' | 'salute' | 'ghost' | 'holiday';
  /** Every colour of the show: confetti mixes them within one burst. */
  palette: readonly string[];
  /** The drawn things a holiday burst throws, repeated in this order. */
  ornaments: readonly HolidayOrnament[];
  bursts: readonly FireworksBurst[];
}

const LAYOUT = [
  { id: 'left', x: 22, y: 58, delay: 0, radius: 120 },
  { id: 'center', x: 50, y: 42, delay: 120, radius: 150 },
  { id: 'right', x: 78, y: 55, delay: 200, radius: 130 },
] as const;

const PALETTES = {
  default: ['--status-success', '--primary-base', '--status-info', '--status-warning'],
  // Removed lines are red in every diff.
  deletion: ['--status-error', '--status-error', '--status-error'],
  newYear: ['--status-warning', '--primary-base', '--status-warning'],
  candy: ['--status-warning', '--primary-base', '--status-error'],
} as const;

// The order repeats through every burst, so an ornament listed twice is thrown twice as often.
const HOLIDAY_ORNAMENTS = {
  valentines: ['heart'],
  stPatricks: ['clover'],
  lunarNewYear: ['lantern', 'envelope'],
  eidAlFitr: ['crescent', 'fanous', 'goldStar', 'crescent', 'fanous', 'crescent'],
  winterHolidays: ['tree', 'bauble', 'gift', 'bauble', 'dreidel', 'bauble'],
  ukraineIndependence: ['uaFlag', 'sunflower', 'uaStar'],
  usIndependence: ['usFlag', 'usStar', 'usStar'],
  thanksgiving: ['turkey', 'pie', 'mapleLeaf', 'mapleLeaf'],
  spring: ['flower'],
  summer: ['sunglasses', 'beachUmbrella', 'cocktail'],
  autumn: ['mapleLeaf', 'mapleLeaf', 'rainUmbrella', 'mapleLeaf', 'mapleLeaf', 'book'],
  winter: ['snowflake'],
} satisfies Record<Exclude<Celebration, 'halloween' | 'newYear'>, readonly HolidayOrnament[]>;

// Hearts and flowers read at confetti size; everything else has details that need more room.
const CONFETTI_SIZED: ReadonlySet<HolidayOrnament> = new Set(['heart', 'flower']);

export const holidayOrnamentScale = (ornament: HolidayOrnament): number => (CONFETTI_SIZED.has(ornament) ? 1 : 1.5);

const VOLLEY_GAP_MS = 450;
const VOLLEY_SHIFT_X = [0, -9, 9, -4, 4] as const;
const MAX_VOLLEYS = VOLLEY_SHIFT_X.length;
const BASE_ON_SCREEN_MS = 3400;
// Ghosts drift longer than confetti falls.
const GHOST_EXTRA_MS = 800;

// The volleys wait for the burst at the button to open first.
const AFTER_ORIGIN_MS = 300;
const ORIGIN_RADIUS = 140;

export const fireworksShowFor = (
  { kind = 'push', volleys }: CelebrationOptions,
  celebration: Celebration | null,
  origin: BurstOrigin | null = null,
): FireworksShow => {
  const newYear = celebration === 'newYear';
  const ornaments = celebration && celebration !== 'halloween' && celebration !== 'newYear' ? HOLIDAY_ORNAMENTS[celebration] : [];
  const particle = celebration === 'halloween' ? 'ghost' : newYear ? 'salute' : ornaments.length > 0 ? 'holiday' : 'confetti';
  const palette = particle === 'ghost'
    ? PALETTES.candy
    : newYear ? PALETTES.newYear : kind === 'deletion' ? PALETTES.deletion : PALETTES.default;
  const requested = (volleys ?? (kind === 'merge' ? 2 : 1)) + (newYear ? 1 : 0);
  const count = Math.max(1, Math.min(requested, MAX_VOLLEYS));
  const bursts = Array.from({ length: count }, (_, volley) => LAYOUT.map((burst, index) => ({
    ...burst,
    id: `${burst.id}-${volley}`,
    x: burst.x + VOLLEY_SHIFT_X[volley],
    y: burst.y - (volley % 2) * 8,
    delay: burst.delay + volley * VOLLEY_GAP_MS,
    colorVar: palette[(index + volley) % palette.length],
  }))).flat();
  if (!origin) return { particle, palette, ornaments, bursts };
  return {
    particle,
    palette,
    ornaments,
    bursts: [
      { id: 'origin', x: origin.x, y: origin.y, delay: 0, radius: ORIGIN_RADIUS, colorVar: palette[0] },
      ...bursts.map((burst) => ({ ...burst, delay: burst.delay + AFTER_ORIGIN_MS })),
    ],
  };
};

/** How long the overlay stays mounted: long enough for the last burst to finish. */
/** The centre of the element, if it is still on screen. */
export const burstOriginOf = (element: HTMLElement | null | undefined): BurstOrigin | null => {
  if (!element?.isConnected || window.innerWidth === 0 || window.innerHeight === 0) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: ((rect.left + rect.width / 2) / window.innerWidth) * 100,
    y: ((rect.top + rect.height / 2) / window.innerHeight) * 100,
  };
};

export const fireworksShowDurationMs = (show: FireworksShow): number => (
  BASE_ON_SCREEN_MS
  + Math.max(0, ...show.bursts.map((burst) => burst.delay))
  + (show.particle === 'ghost' ? GHOST_EXTRA_MS : 0)
);
