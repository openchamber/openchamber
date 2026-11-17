import { getReadableThemeColors } from '@/lib/theme/readableColors';
import type { Theme } from '@/types/theme';


const CHART_SERIES = {
    dark: ['#60a5fa', '#2dd4bf', '#a78bfa', '#f472b6', '#a3e635'],
    light: ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#65a30d'],
} as const;

const SERIES_COUNT = 6;

export const chartSeriesColors = (theme: Theme): string[] => [theme.colors.primary.base, ...CHART_SERIES[theme.metadata.variant]];

export const seriesColor = (index: number) => `var(--oc-series-${(index % SERIES_COUNT) + 1})`;

const TONES = ['success', 'warning', 'error', 'info'] as const;

export const TILE_TONES = {
    dark: { '--oc-tile-tone': '3%', '--oc-tile-inset-tone': '4.5%', '--oc-tile-hover-tone': '5.5%' },
    light: { '--oc-tile-tone': '4%', '--oc-tile-inset-tone': '6%', '--oc-tile-hover-tone': '7%' },
} as const;

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
        ...TILE_TONES[theme.metadata.variant],
    };
}

const rem = (amount: number) => `calc(var(--oc-rem,1rem) * ${amount})`;

export const KIT_SHARED_CSS = `.oc-box{box-sizing:border-box;padding:${rem(0.625)} ${rem(0.75)};border-radius:${rem(0.75)};background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-tone),transparent)}`
    + '.oc-box .oc-box{background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-inset-tone),transparent)}'
    + '.oc-badge{display:inline-flex;align-items:center;padding:.0625em .5em;border-radius:999px;background-color:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--muted-foreground);font-size:.8125em;font-weight:500;line-height:1.45;white-space:nowrap}'
    + '.oc-badge[data-tone]{background-color:color-mix(in srgb,var(--oc-tone) 15%,transparent);color:var(--oc-tone-text)}'
    + TONES.map((tone) => `.oc-badge[data-tone=${tone}]{--oc-tone:var(--oc-tone-${tone});--oc-tone-text:var(--oc-${tone}-text)}`).join('')
    + '.oc-dot{display:inline-block;width:.5em;height:.5em;border-radius:50%;background-color:var(--color,var(--oc-series-1));vertical-align:.1em}'
    + '.oc-track,.oc-bar{background-color:color-mix(in srgb,var(--foreground) 6%,transparent)}'
    + `.oc-bar{display:block;height:${rem(0.375)};border-radius:999px;overflow:hidden}`
    + '.oc-bar::before{content:"";display:block;width:var(--value,0%);max-width:100%;height:100%;border-radius:inherit;background-color:var(--color,var(--oc-series-1))}';
