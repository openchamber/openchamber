import { getReadableThemeColors } from '@/lib/theme/readableColors';
import type { Theme } from '@/types/theme';

/**
 * What an HTML page an agent draws (`message/parts/htmlRender.ts`) and a UI
 * block (`uiBlocks/UiBlock.tsx`) show alike: chart series colours, badges and
 * their tones, legend dots, bars on their track, and boxes. Both read this one
 * module, so a chart or a badge looks the same drawn either way and a change
 * lands in both at once. A page gets the variables in its bootstrap and the CSS
 * in its kit; a block sets the variables on its root and the CSS is added to
 * the document once.
 */

/**
 * Chart series after the accent, the same in every theme. A theme's syntax
 * colors were used here first, but they are picked for reading code: in the
 * default theme they made near-twins (the accent orange beside the string
 * salmon, two teals, two greens), and the first two series of almost every
 * chart blurred together. These hues stay apart from each other and from any
 * accent; the light set is darker so it holds on a light background.
 */
const CHART_SERIES = {
    dark: ['#60a5fa', '#2dd4bf', '#a78bfa', '#f472b6', '#a3e635'],
    light: ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#65a30d'],
} as const;

/** How many series colours there are before they repeat. */
const SERIES_COUNT = 6;

/** A chart's series colours: the theme's accent first, so the main series reads as the app's own. */
export const chartSeriesColors = (theme: Theme): string[] => [theme.colors.primary.base, ...CHART_SERIES[theme.metadata.variant]];

/** The colour of series `index`, from the variables `kitVariables` sets. */
export const seriesColor = (index: number) => `var(--oc-series-${(index % SERIES_COUNT) + 1})`;

const TONES = ['success', 'warning', 'error', 'info'] as const;

/** The variables the shared CSS reads: series colours, and each tone with text that stays readable on its own tint. */
export function kitVariables(theme: Theme) {
    const readable = getReadableThemeColors(theme);
    const { status } = theme.colors;
    return {
        ...Object.fromEntries(chartSeriesColors(theme).map((color, index) => [`--oc-series-${index + 1}`, color])),
        '--oc-tone-success': status.success,
        '--oc-tone-warning': status.warning,
        '--oc-tone-error': status.error,
        '--oc-tone-info': status.info,
        '--oc-success-text': readable.tinted.success,
        '--oc-warning-text': readable.tinted.warning,
        '--oc-error-text': readable.tinted.error,
        '--oc-info-text': readable.tinted.info,
    };
}

// Sizes follow the interface size: a page sets --oc-rem to the app's rem, in
// the app it falls back to rem itself.
const rem = (amount: number) => `calc(var(--oc-rem,1rem) * ${amount})`;

/**
 * A box is the app's flat tile (`.oc-tile`): no border, a tone step on what it
 * sits on, the next step inside another box. A track is the groove a bar runs
 * in; `.oc-bar` is a whole bar on its track, as long as --value, coloured by
 * --color.
 */
export const KIT_SHARED_CSS = `.oc-box{box-sizing:border-box;padding:${rem(0.625)} ${rem(0.75)};border-radius:${rem(0.75)};background-color:color-mix(in srgb,var(--foreground) 4%,transparent)}`
    + '.oc-box .oc-box{background-color:color-mix(in srgb,var(--foreground) 6%,transparent)}'
    + '.oc-badge{display:inline-flex;align-items:center;padding:.0625em .5em;border-radius:999px;background-color:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--muted-foreground);font-size:.8125em;font-weight:500;line-height:1.45;white-space:nowrap}'
    + '.oc-badge[data-tone]{background-color:color-mix(in srgb,var(--oc-tone) 15%,transparent);color:var(--oc-tone-text)}'
    + TONES.map((tone) => `.oc-badge[data-tone=${tone}]{--oc-tone:var(--oc-tone-${tone});--oc-tone-text:var(--oc-${tone}-text)}`).join('')
    + '.oc-dot{display:inline-block;width:.5em;height:.5em;border-radius:50%;background-color:var(--color,var(--oc-series-1));vertical-align:.1em}'
    + '.oc-track,.oc-bar{background-color:color-mix(in srgb,var(--foreground) 6%,transparent)}'
    + `.oc-bar{display:block;height:${rem(0.375)};border-radius:999px;overflow:hidden}`
    + '.oc-bar::before{content:"";display:block;width:var(--value,0%);max-width:100%;height:100%;border-radius:inherit;background-color:var(--color,var(--oc-series-1))}';
