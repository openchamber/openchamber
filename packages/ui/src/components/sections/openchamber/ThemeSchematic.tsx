import React from 'react';

import { getReadableThemeColors } from '@/lib/theme/readableColors';
import { withPrColors } from '@/lib/theme/themes/prColors';
import type { Theme } from '@/types/theme';

export type ThemeSchematicLayout = 'desktop' | 'phone';

interface ThemeSchematicProps {
  theme: Theme;
  /** Draws this theme over the left part of the picture, cut on a diagonal (the System card). */
  splitWith?: Theme;
  layout: ThemeSchematicLayout;
  className?: string;
}

/**
 * A drawing of the app in a given theme, for the Appearance page. It paints
 * every part with the token the real component uses, including the fallback
 * chains of `cssGenerator` and the opacities the components put on top, so a
 * theme looks here the way it looks in the app. The theme is not the active
 * one, so colours come from the theme object, not from CSS variables.
 */
export function ThemeSchematic({ theme, splitWith, layout, className }: ThemeSchematicProps) {
  const clipId = React.useId();
  const size = layout === 'phone' ? PHONE_SIZE : DESKTOP_SIZE;
  const Draw = layout === 'phone' ? PhoneDrawing : DesktopDrawing;
  const colors = React.useMemo(() => resolveColors(theme), [theme]);
  const splitColors = React.useMemo(() => (splitWith ? resolveColors(splitWith) : null), [splitWith]);

  return (
    <svg aria-hidden viewBox={`0 0 ${size.w} ${size.h}`} className={className}>
      <Draw c={colors} />
      {splitColors ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <polygon points={`0,0 ${size.w * 0.62},0 ${size.w * 0.38},${size.h} 0,${size.h}`} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <Draw c={splitColors} />
          </g>
        </>
      ) : null}
    </svg>
  );
}

type Colors = ReturnType<typeof resolveColors>;

const mix = (color: string, percent: number, base = 'transparent') => `color-mix(in oklab, ${color} ${percent}%, ${base})`;

/** Tokens as the app resolves them (cssGenerator, design-system.css), each with its component opacity. */
function resolveColors(source: Theme) {
  const theme = withPrColors(source);
  const { surface, interactive, status, primary, chat, markdown, tools, pr, syntax } = theme.colors;
  const dark = theme.metadata.variant === 'dark';
  const readable = getReadableThemeColors(theme);
  const chatBackground = chat?.background || surface.background;
  return {
    dark,
    background: surface.background,
    foreground: surface.foreground,
    muted: surface.muted,
    mutedForeground: surface.mutedForeground,
    elevated: surface.elevated,
    elevatedForeground: surface.elevatedForeground || surface.foreground,
    border: interactive.border,
    primary: primary.base,
    success: status.success,
    info: status.info,
    warning: status.warning,
    /** Session rows at rest (`oc-title-rest`). */
    titleRest: `color-mix(in oklab, ${surface.foreground} 50%, ${surface.mutedForeground})`,
    selection: mix(interactive.selection, 70),
    selectionForeground: readable.selectionForeground,
    /** Message text is foreground at 90%. */
    text: mix(surface.foreground, 90),
    bold: markdown?.bold || surface.foreground,
    inlineCode: mix(markdown?.inlineCode || syntax.base.string, 90),
    inlineCodeBackground: mix(markdown?.inlineCodeBackground || chatBackground, 50),
    inlineCodeWash: mix(surface.foreground, 4),
    userBubble: chat?.userMessageBackground ?? surface.elevated,
    userBubbleEdge: mix(primary.base, 5),
    toolsIcon: tools?.icon || surface.mutedForeground,
    toolsTitle: tools?.title || surface.foreground,
    toolsDescription: tools?.description || mix(surface.mutedForeground, 60),
    chatDivider: chat?.divider ?? interactive.border,
    /** Effort level in the composer: the warning text tone at 75%. */
    effort: mix(readable.status.warning, 75),
    prOpen: pr?.open ?? status.success,
    prMerged: pr?.merged ?? status.info,
    /** `oc-panel-edge`: a docked panel takes the sidebar's colour, halfway to it in light themes, inside a hairline ring. */
    panel: dark ? surface.muted : `color-mix(in srgb, ${surface.muted} 50%, ${surface.background})`,
    edgeRing: dark ? 'rgb(255 255 255 / 0.08)' : 'rgb(0 0 0 / 0.14)',
    /** `.oc-box`: the UI block card is a tone step of the text colour. */
    box: mix(surface.foreground, dark ? 3 : 4),
  };
}

interface RectProps { x: number; y: number; w: number; h: number; fill: string; r?: number }

const Rect = ({ x, y, w, h, fill, r = 0 }: RectProps) => <rect x={x} y={y} width={w} height={h} rx={r} style={{ fill }} />;
/** A line of text. */
const Bar = ({ x, y, w, fill, h = 4.5 }: { x: number; y: number; w: number; fill: string; h?: number }) => (
  <rect x={x} y={y} width={w} height={h} rx={h / 2} style={{ fill }} />
);
const Ring = ({ cx, cy, r, stroke, width = 1.3 }: { cx: number; cy: number; r: number; stroke: string; width?: number }) => (
  <circle cx={cx} cy={cy} r={r} style={{ fill: 'none', stroke, strokeWidth: width }} />
);
const Dot = ({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) => (
  <circle cx={cx} cy={cy} r={r} style={{ fill }} />
);
/** A context meter: track in the button colour at 30%, arc in the tone of the usage. */
const Meter = ({ cx, cy, r, track, arc, value }: { cx: number; cy: number; r: number; track: string; arc: string; value: number }) => {
  const length = 2 * Math.PI * r;
  return (
    <g transform={`rotate(-90 ${cx} ${cy})`}>
      <circle cx={cx} cy={cy} r={r} style={{ fill: 'none', stroke: track, strokeWidth: 1.3 }} />
      <circle cx={cx} cy={cy} r={r} strokeDasharray={`${length * value} ${length}`} style={{ fill: 'none', stroke: arc, strokeWidth: 1.3 }} />
    </g>
  );
};
/** Inline code: a chip with the code colour inside. */
const Code = ({ x, y, w, c }: { x: number; y: number; w: number; c: Colors }) => (
  <>
    <Rect x={x - 2} y={y - 2} w={w + 4} h={8.5} r={2.5} fill={c.inlineCodeBackground} />
    <Rect x={x - 2} y={y - 2} w={w + 4} h={8.5} r={2.5} fill={c.inlineCodeWash} />
    <Bar x={x} y={y} w={w} fill={c.inlineCode} />
  </>
);

/** A UI block with a line chart: caption, headline figure, then an area in the first series colour. */
function ChartCard({ x, y, w, h, c }: { x: number; y: number; w: number; h: number; c: Colors }) {
  const gradientId = React.useId();
  // [x, depth from the top]: the line climbs toward the end.
  const points = [[0, 0.75], [0.18, 0.65], [0.36, 0.8], [0.55, 0.62], [0.72, 0.3], [0.86, 0.1], [1, 0]];
  const plotX = x + 4;
  const plotW = w - 8;
  const plotY = y + 19;
  const plotH = h - 25;
  const plotted = points.map(([px, v]) => [plotX + px * plotW, plotY + (v + 0.1) * plotH * 0.9]);
  const line = plotted.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const last = plotted[plotted.length - 1];
  return (
    <>
      <Rect x={x} y={y} w={w} h={h} r={4} fill={c.box} />
      <Bar x={x + 4} y={y + 4} w={30} h={3} fill={c.mutedForeground} />
      <Bar x={x + 4} y={y + 10} w={12} h={4} fill={c.text} />
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: c.primary, stopOpacity: 0.28 }} />
          <stop offset="1" style={{ stopColor: c.primary, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={`${line} L${plotX + plotW} ${plotY + plotH} L${plotX} ${plotY + plotH} Z`} fill={`url(#${gradientId})`} />
      <path d={line} style={{ fill: 'none', stroke: c.primary, strokeWidth: 1.3 }} />
      <Dot cx={last[0]} cy={last[1]} r={1.8} fill={c.primary} />
    </>
  );
}

const DESKTOP_SIZE = { w: 240, h: 150 };
const PHONE_SIZE = { w: 100, h: 180 };

/** Context usage drawn on the meters: low enough to read as the success tone, as most sessions do. */
const CONTEXT_USAGE = 0.34;

function DesktopDrawing({ c }: { c: Colors }) {
  const { w: W, h: H } = DESKTOP_SIZE;
  const sidebarWidth = 64;
  const rail = 14;
  const railX = W - rail + 4;

  // Sidebar rows: [title width, mark]
  type Mark = 'running' | 'unread' | 'merged' | 'open' | null;
  const inWork: Array<[number, Mark]> = [[32, 'running'], [26, 'unread'], [36, null]];
  const projects: Array<[number, Mark, boolean?]> = [[30, null], [28, 'merged', true], [36, 'open'], [24, null]];
  let y = 14;
  const sidebar: React.ReactNode[] = [];
  const caption = (w: number) => {
    sidebar.push(<Bar key={`c${y}`} x={8} y={y} w={w} h={4} fill={c.mutedForeground} />);
    y += 13;
  };
  const row = (w: number, mark: Mark, selected = false) => {
    if (selected) sidebar.push(<Rect key={`s${y}`} x={4} y={y - 5} w={sidebarWidth - 8} h={15} r={4} fill={c.selection} />);
    const unread = mark === 'unread';
    sidebar.push(<Bar key={`t${y}`} x={11} y={y} w={w} fill={selected ? c.selectionForeground : unread ? c.foreground : c.titleRest} />);
    const cx = sidebarWidth - 11;
    const cy = y + 2.25;
    if (mark === 'running') sidebar.push(<Ring key={`m${y}`} cx={cx} cy={cy} r={2.8} stroke={c.info} />);
    if (unread) sidebar.push(<Dot key={`m${y}`} cx={cx} cy={cy} r={3} fill={c.success} />);
    if (mark === 'merged' || mark === 'open') {
      sidebar.push(<Rect key={`m${y}`} x={cx - 3} y={cy - 3} w={6} h={6} r={1.6} fill={mark === 'merged' ? c.prMerged : c.prOpen} />);
    }
    y += 14;
  };
  caption(20);
  inWork.forEach(([w, mark]) => row(w, mark));
  y += 5;
  caption(24);
  projects.forEach(([w, mark, selected]) => row(w, mark, selected));

  // Session card
  const pw = 52;
  const px = W - rail - pw - 3;
  const py = 21;
  const card: React.ReactNode[] = [];
  let ry = py + 7;
  const ph = 80;
  card.push(<Bar key="h1" x={px + 6} y={ry} w={18} h={4} fill={c.foreground} />);
  ry += 9;
  card.push(<Bar key="tr" x={px + 6} y={ry} w={pw - 12} h={2.4} fill={c.chatDivider} />);
  card.push(<Bar key="fi" x={px + 6} y={ry} w={(pw - 12) * CONTEXT_USAGE} h={2.4} fill={c.success} />);
  ry += 8;
  const issueRows: Array<{ color: string; w: number }> = [{ color: c.prOpen, w: 18 }, { color: c.prMerged, w: 14 }];
  issueRows.forEach(({ color, w }, index) => {
    card.push(<Ring key={`i${index}`} cx={px + 8.5} cy={ry + 2} r={2.2} stroke={color} width={1.1} />);
    card.push(<Bar key={`il${index}`} x={px + 13} y={ry} w={w} h={4} fill={color} />);
    card.push(<Bar key={`ir${index}`} x={px + 16 + w} y={ry} w={pw - 22 - w} h={4} fill={c.mutedForeground} />);
    ry += 9;
  });
  ry += 3;
  card.push(<Bar key="h2" x={px + 6} y={ry} w={22} h={4} fill={c.foreground} />);
  ry += 9;
  [22, 28].forEach((w, index) => {
    card.push(<Ring key={`s${index}`} cx={px + 8.5} cy={ry + 2} r={2.2} stroke={c.success} width={1.1} />);
    card.push(<Bar key={`sl${index}`} x={px + 13} y={ry} w={w} h={4} fill={c.mutedForeground} />);
    ry += 9;
  });

  // Chat column
  const c0 = sidebarWidth + 10;
  const c1 = px - 9;
  const cw = c1 - c0;

  // Composer
  const kh = 28;
  const ky = H - kh - 6;
  const by = ky + kh - 10;

  return (
    <>
      <Rect x={0} y={0} w={W} h={H} fill={c.background} />

      <Rect x={0} y={0} w={sidebarWidth} h={H} fill={c.muted} />
      <Rect x={sidebarWidth - 0.5} y={0} w={0.5} h={H} fill={c.border} />
      {sidebar}

      {/* Header: session title, context meter, icon buttons */}
      <Bar x={sidebarWidth + 9} y={7} w={48} fill={c.foreground} />
      <Meter cx={railX - 15} cy={9.25} r={3} track={mix(c.mutedForeground, 30)} arc={c.success} value={CONTEXT_USAGE} />
      <Rect x={railX - 8} y={7} w={4.5} h={4.5} r={1.2} fill={c.mutedForeground} />
      <Rect x={railX + 1} y={7} w={4.5} h={4.5} r={1.2} fill={c.mutedForeground} />

      {/* Context rail: one active surface, a selection rather than an action, so in the text colour */}
      {Array.from({ length: 7 }, (_, index) => (
        <Rect key={index} x={railX + 1} y={23 + index * 11} w={4.5} h={4.5} r={1.2} fill={index === 0 ? c.foreground : c.mutedForeground} />
      ))}

      <Rect x={px} y={py} w={pw} h={ph} r={5} fill={c.panel} />
      <rect x={px + 0.25} y={py + 0.25} width={pw - 0.5} height={ph - 0.5} rx={4.75} style={{ fill: 'none', stroke: c.edgeRing, strokeWidth: 0.5 }} />
      {card}

      {/* User message, then the answer: text with inline code, a chart block, a list item */}
      <Rect x={c1 - 54} y={18} w={54} h={14} r={5} fill={c.userBubble} />
      <rect x={c1 - 53.75} y={18.25} width={53.5} height={13.5} rx={4.75} style={{ fill: 'none', stroke: c.userBubbleEdge, strokeWidth: 0.5 }} />

      <Bar x={c0} y={40} w={20} fill={c.text} />
      <Code x={c0 + 25} y={40} w={16} c={c} />
      <Bar x={c0 + 47} y={40} w={cw - 47} fill={c.text} />

      <ChartCard x={c0 - 1} y={50} w={cw + 2} h={44} c={c} />

      <Dot cx={c0 + 2.5} cy={104.25} r={1.7} fill={c.text} />
      <Code x={c0 + 8} y={102} w={14} c={c} />
      <Bar x={c0 + 26} y={102} w={cw - 26} fill={c.bold} />

      {/* Composer: elevated surface, its own foreground */}
      <Rect x={c0 - 3} y={ky} w={cw + 6} h={kh} r={7} fill={c.elevated} />
      <rect x={c0 - 2.75} y={ky + 0.25} width={cw + 5.5} height={kh - 0.5} rx={6.75} style={{ fill: 'none', stroke: c.edgeRing, strokeWidth: 0.5 }} />
      <Bar x={c0 + 4} y={ky + 7} w={cw * 0.6} fill={mix(c.mutedForeground, 60)} />
      <Ring cx={c0 + 6} cy={by + 2.25} r={2.8} stroke={c.elevatedForeground} />
      <Bar x={c1 - 58} y={by} w={14} fill={c.elevatedForeground} />
      <Bar x={c1 - 41} y={by} w={12} fill={c.effort} />
      <Ring cx={c1 - 22} cy={by + 2.25} r={2.6} stroke={c.success} />
      <Bar x={c1 - 17} y={by} w={9} fill={c.success} />
      <path d={`M${c1 - 6} ${by - 1} l6 3.5 l-6 3.5 z`} style={{ fill: mix(c.elevatedForeground, 30) }} />
    </>
  );
}

function PhoneDrawing({ c }: { c: Colors }) {
  const { w: W, h: H } = PHONE_SIZE;
  const c0 = 8;
  const cw = W - 16;

  const cardY = 35;
  const cardH = 40;

  const kh = 32;
  const ky = H - kh - 6;
  const by = ky + kh - 10;
  let y = cardY + cardH + 8;
  const lines = [cw * 0.95, cw * 0.8].map((w) => {
    const node = <Bar key={y} x={c0} y={y} w={w} fill={c.text} />;
    y += 10;
    return node;
  });
  y += 3;
  const codeLine1 = y;
  const codeLine2 = y + 11;
  const meta = y + 23;

  return (
    <>
      <Rect x={0} y={0} w={W} h={H} fill={c.background} />

      {/* Header: menu, title, context meter, tools with a badge */}
      {[0, 1, 2].map((index) => <Bar key={index} x={8} y={9 + index * 3} w={7} h={1.6} fill={c.mutedForeground} />)}
      <Bar x={20} y={10} w={34} fill={c.foreground} />
      <Meter cx={W - 22} cy={12.5} r={3} track={c.border} arc={c.success} value={CONTEXT_USAGE} />
      <Rect x={W - 13} y={9.5} w={6} h={6} r={1.6} fill={c.mutedForeground} />
      <Dot cx={W - 7} cy={9} r={2.2} fill={c.background} />
      <Dot cx={W - 7} cy={9} r={1.4} fill={c.warning} />

      <Bar x={c0} y={25} w={cw * 0.9} fill={c.text} />

      <ChartCard x={c0 - 1} y={cardY} w={cw + 2} h={cardH} c={c} />

      {lines}
      <Bar x={c0} y={codeLine1} w={22} fill={c.text} />
      <Code x={c0 + 27} y={codeLine1} w={26} c={c} />
      <Bar x={c0 + 59} y={codeLine1} w={cw - 59} fill={c.text} />
      <Bar x={c0} y={codeLine2} w={10} fill={c.text} />
      <Code x={c0 + 15} y={codeLine2} w={26} c={c} />
      <Bar x={c0 + 47} y={codeLine2} w={24} fill={c.text} />
      <Bar x={c0} y={meta} w={40} h={3.5} fill={c.mutedForeground} />

      {/* Composer: input row, then model / effort and the agent */}
      <Rect x={5} y={ky} w={W - 10} h={kh} r={8} fill={c.elevated} />
      <rect x={5.25} y={ky + 0.25} width={W - 10.5} height={kh - 0.5} rx={7.75} style={{ fill: 'none', stroke: c.edgeRing, strokeWidth: 0.5 }} />
      <Ring cx={12} cy={ky + 9.5} r={2.8} stroke={c.elevatedForeground} />
      <Bar x={19} y={ky + 7} w={50} fill={c.elevatedForeground} />
      <path d={`M${W - 15} ${ky + 6} l6 3.5 l-6 3.5 z`} style={{ fill: 'none', stroke: c.primary, strokeWidth: 1.2, strokeLinejoin: 'round' }} />
      <Bar x={10} y={by} w={22} fill={mix(c.elevatedForeground, 80)} />
      <Bar x={35} y={by} w={14} fill={c.effort} />
      <Bar x={W - 24} y={by} w={14} fill={c.success} />
    </>
  );
}
