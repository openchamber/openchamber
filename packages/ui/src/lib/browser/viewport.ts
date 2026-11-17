export type BrowserViewport =
  | { readonly kind: 'fill' }
  | { readonly kind: 'preset'; readonly id: string; readonly width: number; readonly height: number }
  | { readonly kind: 'custom'; readonly width: number; readonly height: number };

export const FILL_VIEWPORT: BrowserViewport = { kind: 'fill' };

export const MIN_VIEWPORT_SIZE = 240;
export const MAX_VIEWPORT_SIZE = 3840;

type ViewportPreset = {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
};

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'iphone-14', label: 'iPhone 14', width: 390, height: 844 },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932 },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915 },
  { id: 'ipad-mini', label: 'iPad mini', width: 768, height: 1024 },
  { id: 'ipad-pro', label: 'iPad Pro', width: 1024, height: 1366 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
];

export const clampViewportSize = (value: number): number => {
  if (!Number.isFinite(value)) return MIN_VIEWPORT_SIZE;
  return Math.round(Math.min(MAX_VIEWPORT_SIZE, Math.max(MIN_VIEWPORT_SIZE, value)));
};

export const viewportSize = (
  viewport: BrowserViewport,
): { width: number; height: number } | null => (
  viewport.kind === 'fill' ? null : { width: viewport.width, height: viewport.height }
);

export const presetViewport = (id: string): BrowserViewport | null => {
  const preset = VIEWPORT_PRESETS.find((entry) => entry.id === id);
  if (!preset) return null;
  return { kind: 'preset', id: preset.id, width: preset.width, height: preset.height };
};

export const rotateViewport = (viewport: BrowserViewport): BrowserViewport => {
  if (viewport.kind === 'fill') return viewport;
  return { kind: 'custom', width: viewport.height, height: viewport.width };
};

type ViewportLayout = {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
};

export const fitViewport = (
  viewport: BrowserViewport,
  available: { width: number; height: number },
): ViewportLayout | null => {
  const size = viewportSize(viewport);
  if (!size) return null;

  const usableWidth = Math.max(1, available.width);
  const usableHeight = Math.max(1, available.height);
  const scale = Math.min(1, usableWidth / size.width, usableHeight / size.height);
  return { width: size.width, height: size.height, scale };
};

export const describeViewport = (viewport: BrowserViewport): string => {
  if (viewport.kind === 'fill') return '';
  if (viewport.kind === 'preset') {
    return VIEWPORT_PRESETS.find((entry) => entry.id === viewport.id)?.label ?? '';
  }
  return '';
};

const VIEWPORT_MODES = ['mobile', 'tablet', 'desktop', 'fill'] as const;
type BrowserViewportMode = (typeof VIEWPORT_MODES)[number];

const MODE_PRESETS: Record<Exclude<BrowserViewportMode, 'fill'>, string> = {
  mobile: 'iphone-14',
  tablet: 'ipad-mini',
  desktop: 'desktop',
};

export const isViewportMode = (value: unknown): value is BrowserViewportMode => (
  typeof value === 'string' && (VIEWPORT_MODES as readonly string[]).includes(value)
);

export const viewportForMode = (mode: BrowserViewportMode): BrowserViewport => (
  mode === 'fill' ? FILL_VIEWPORT : presetViewport(MODE_PRESETS[mode]) ?? FILL_VIEWPORT
);

export const viewportSummary = (viewport: BrowserViewport): {
  mode: BrowserViewportMode | 'custom';
  width: number | null;
  height: number | null;
} => {
  const size = viewportSize(viewport);
  if (!size) return { mode: 'fill', width: null, height: null };

  for (const mode of ['mobile', 'tablet', 'desktop'] as const) {
    const preset = viewportForMode(mode);
    const presetSize = viewportSize(preset);
    if (presetSize && presetSize.width === size.width && presetSize.height === size.height) {
      return { mode, width: size.width, height: size.height };
    }
  }
  return { mode: 'custom', width: size.width, height: size.height };
};
