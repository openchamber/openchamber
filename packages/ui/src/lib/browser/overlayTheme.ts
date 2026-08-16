/**
 * Resolves OpenChamber theme tokens into concrete color strings.
 *
 * The annotation overlay renders inside a page we do not control, so it cannot
 * reference our CSS variables — that page has its own `:root`. Theme tokens can
 * also be authored in any color space, so string-concatenating an alpha suffix
 * onto them is not safe. Both problems go away by letting the browser resolve
 * the values here: a probe element carries the token, and the computed style is
 * always a concrete color the overlay can use verbatim.
 */
import type { BrowserAnnotationOverlayTheme } from './annotationOverlay';

const FALLBACK: BrowserAnnotationOverlayTheme = {
  colorScheme: 'dark',
  primary: 'rgb(59, 130, 246)',
  primarySoft: 'rgba(59, 130, 246, 0.16)',
  primaryFaint: 'rgba(59, 130, 246, 0.10)',
  primaryContrast: 'rgb(255, 255, 255)',
  surface: 'rgb(24, 24, 27)',
  surfaceElevated: 'rgb(32, 32, 36)',
  glassSurface: 'rgba(32, 32, 36, 0.64)',
  glassFilter: 'blur(26px) saturate(1.16)',
  border: 'rgba(255, 255, 255, 0.14)',
  text: 'rgb(244, 244, 245)',
  mutedText: 'rgba(244, 244, 245, 0.62)',
};

type Probe = {
  readonly read: (value: string) => string;
  readonly readVariable: (name: string) => string;
  readonly dispose: () => void;
};

const createProbe = (): Probe | null => {
  if (typeof document === 'undefined' || !document.body) return null;
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none';
  document.body.appendChild(element);
  return {
    read: (value: string): string => {
      element.style.backgroundColor = '';
      element.style.backgroundColor = value;
      const resolved = window.getComputedStyle(element).backgroundColor;
      return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : '';
    },
    readVariable: (name: string): string => (
      window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    ),
    dispose: () => element.remove(),
  };
};

/**
 * Reads the live theme. Returns a usable palette even when probing fails, so a
 * missing token can never leave the overlay invisible against the page.
 */
export const resolveAnnotationOverlayTheme = (colorScheme: 'light' | 'dark'): BrowserAnnotationOverlayTheme => {
  const probe = createProbe();
  if (!probe) return { ...FALLBACK, colorScheme };

  try {
    const read = (token: string, fallback: string): string => probe.read(`var(${token})`) || fallback;
    const mix = (token: string, percent: number, fallback: string): string => (
      probe.read(`color-mix(in srgb, var(${token}) ${percent}%, transparent)`) || fallback
    );

    // The same recipe the app's tooltips and popovers use, resolved here
    // because the overlay cannot reach our stylesheet from inside the page.
    const glassOpacity = probe.readVariable('--oc-glass-tooltip-opacity') || '62%';
    const blur = probe.readVariable('--oc-glass-blur') || '26px';
    const saturation = probe.readVariable('--oc-glass-saturation') || '1.16';

    return {
      colorScheme,
      glassSurface: probe.read(`color-mix(in srgb, var(--surface-elevated) ${glassOpacity}, transparent)`)
        || FALLBACK.glassSurface,
      glassFilter: `blur(${blur}) saturate(${saturation})`,
      primary: read('--primary', FALLBACK.primary),
      primarySoft: mix('--primary', 16, FALLBACK.primarySoft),
      primaryFaint: mix('--primary', 10, FALLBACK.primaryFaint),
      primaryContrast: read('--primary-foreground', FALLBACK.primaryContrast),
      surface: read('--surface-background', FALLBACK.surface),
      surfaceElevated: read('--surface-elevated', FALLBACK.surfaceElevated),
      border: read('--border', FALLBACK.border),
      text: read('--foreground', FALLBACK.text),
      mutedText: read('--muted-foreground', FALLBACK.mutedText),
    };
  } catch {
    return { ...FALLBACK, colorScheme };
  } finally {
    probe.dispose();
  }
};
