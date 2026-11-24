import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { seriesColor } from '../lib/visualKit';
import { axisTicks } from '../uiBlocks/axisTicks';

export interface A2uiChartSeries {
  name: string;
  values: Array<number | null>;
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });
const formatNumber = (value: number) => numberFormat.format(value).replace(/,/g, '\u202F');
const unitSuffix = (unit?: string) => (!unit ? '' : /^[%°]/.test(unit) ? unit : `\u00A0${unit}`);
const unitLeads = (unit?: string) => unit === '$' || unit === '£' || unit === '€';
const formatWithUnit = (value: number, unit?: string) =>
  unitLeads(unit) ? `${unit}${formatNumber(value)}` : `${formatNumber(value)}${unitSuffix(unit)}`;
const formatShare = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
const pointsOf = (series: A2uiChartSeries[]) =>
  series.flatMap((item) => item.values.filter((point): point is number => typeof point === 'number' && Number.isFinite(point)));

const segmentsOf = (values: Array<number | null>): Array<Array<{ index: number; point: number }>> => {
  const segments: Array<Array<{ index: number; point: number }>> = [];
  let current: Array<{ index: number; point: number }> = [];
  values.forEach((point, index) => {
    if (point === null || !Number.isFinite(point)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ index, point });
    }
  });
  if (current.length) segments.push(current);
  return segments;
};

const lastPoint = (values: Array<number | null>) => {
  for (let index = values.length - 1; index >= 0; index--) {
    const point = values[index];
    if (point !== null && point !== undefined && Number.isFinite(point)) return { index, point };
  }
  return null;
};

function HeadlineUnit({ unit, leading = false }: { unit?: string; leading?: boolean }) {
  if (!unit || unitLeads(unit) !== leading) return null;
  if (leading) return <>{unit}</>;
  return <span className="typography-meta font-normal text-muted-foreground">{unitSuffix(unit)}</span>;
}

export function A2uiBarChart({
  title,
  labels,
  series,
  unit,
  whole,
  inCard = false,
}: {
  title?: string;
  labels: string[];
  series: A2uiChartSeries[];
  unit?: string;
  whole?: boolean;
  inCard?: boolean;
}) {
  const { t } = useI18n();
  const points = pointsOf(series);
  if (labels.length === 0 || points.length === 0) return null;
  const ticks = axisTicks(0, Math.max(0, ...points));
  const scale = ticks[ticks.length - 1] || 1;
  const single = series.length === 1;
  const largest = Math.max(...points);
  const smallest = Math.min(...points);
  const sum = points.reduce((acc, p) => acc + p, 0);
  const total = whole && single && smallest >= 0 && sum > 0 ? sum : null;
  const average = sum / points.length;
  const strength = (point: number) =>
    largest === smallest ? 100 : Math.round(30 + (70 * (point - smallest)) / (largest - smallest));
  const barWidth = (point: number) =>
    total === null ? `${Math.max(0, Math.min(1, point / scale)) * 100}%` : `${(point / total) * 100}%`;

  const figure = (label: string, value: number) => (
    <span className="flex flex-col">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">
        <HeadlineUnit unit={unit} leading />
        {formatNumber(value)}
        <HeadlineUnit unit={unit} />
      </span>
    </span>
  );

  return (
    <div className={cn('flex flex-col gap-3', !inCard && 'oc-box')}>
      {title && <div className="typography-meta font-medium text-muted-foreground">{title}</div>}
      {single ? (
        <div className="flex items-start gap-5">
          {total !== null ? (
            <>
              {figure(t('chat.uiBlock.chart.total'), total)}
              {figure(t('chat.uiBlock.chart.largest'), largest)}
            </>
          ) : (
            <>
              {figure(t('chat.uiBlock.chart.largest'), largest)}
              {figure(t('chat.uiBlock.chart.average'), Math.abs(average) >= 1000 ? Math.round(average) : Number(average.toPrecision(4)))}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
          {series.map((item, idx) => (
            <span key={idx} className="inline-flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(idx) }} />
              {item.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {labels.map((label, labelIndex) => {
          const values = series.map((item) => item.values[labelIndex] ?? null);
          const top = single && values[0] === largest;
          return (
            <div key={labelIndex} className="group/bar flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 typography-meta">
                <span
                  className={cn(
                    'min-w-0 truncate transition-colors duration-150',
                    top ? 'font-semibold text-foreground' : 'text-muted-foreground group-hover/bar:text-foreground',
                  )}
                  title={label}
                >
                  {label}
                </span>
                <span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
                  {values.map((point, seriesIndex) => (
                    <span
                      key={seriesIndex}
                      className={cn(top && 'font-semibold')}
                      style={single ? undefined : { color: seriesColor(seriesIndex) }}
                    >
                      {point === null ? '–' : formatWithUnit(point, unit)}
                    </span>
                  ))}
                  {total !== null && values[0] !== null && (
                    <span className="min-w-[2.5em] text-end font-normal text-muted-foreground">
                      {formatShare(values[0] / total)}
                    </span>
                  )}
                </span>
              </div>
              {values.map((point, seriesIndex) => (
                <div key={seriesIndex} className="oc-track h-1.5 rounded-full">
                  {point !== null && (
                    <div
                      className="h-full rounded-full transition-[width,filter] duration-200 group-hover/bar:brightness-125"
                      style={{
                        width: barWidth(point),
                        background: single
                          ? `color-mix(in srgb, ${seriesColor(0)} ${strength(point)}%, transparent)`
                          : seriesColor(seriesIndex),
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function A2uiLineChart({
  title,
  labels,
  series,
  unit,
  deltaMode = 'absolute',
  inCard = false,
}: {
  title?: string;
  labels: string[];
  series: A2uiChartSeries[];
  unit?: string;
  deltaMode?: 'percent' | 'absolute';
  inCard?: boolean;
}) {
  const { t } = useI18n();
  const [pointed, setPointed] = React.useState<number | null>(null);
  const [pickedSeries, setPickedSeries] = React.useState<number | null>(null);
  const gradientId = `oc-a2ui-area-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const points = pointsOf(series);
  if (labels.length === 0 || points.length === 0) return null;

  const hovered = pointed !== null && pointed < labels.length ? pointed : null;
  const area = series.length === 1;
  const ticks = area
    ? axisTicks(Math.min(...points), Math.max(...points))
    : axisTicks(Math.min(...points, 0), Math.max(...points, 0));
  const low = ticks[0];
  const span = ticks[ticks.length - 1] - low || 1;
  const width = 600;
  const height = 140;
  const xShare = (index: number) => (labels.length < 2 ? 0.5 : index / (labels.length - 1));
  const yShare = (point: number) => 1 - (point - low) / span;
  const step = Math.max(1, Math.ceil((labels.length - 1) / 5));
  const axisLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => index % step === 0 || index === labels.length - 1);

  const singleValues = area ? series[0].values.slice(0, labels.length) : [];
  const firstIdx = area ? singleValues.findIndex((p) => p !== null) : -1;
  const end = area ? lastPoint(singleValues) : null;
  const startVal = firstIdx >= 0 ? singleValues[firstIdx] : null;
  let changeText: string | null = null;
  if (area && startVal !== null && end && end.index !== firstIdx) {
    if (deltaMode === 'percent' && startVal !== 0) {
      const pct = Math.round(((end.point - startVal) / Math.abs(startVal)) * 100);
      changeText = `${pct > 0 ? '+' : ''}${formatNumber(pct)}%`;
    } else {
      const diff = Number((end.point - startVal).toPrecision(4));
      const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
      changeText = `${sign}${formatWithUnit(Math.abs(diff), unit)}`;
    }
  }

  const pointAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || labels.length === 0) return;
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setPointed(labels.length < 2 ? 0 : Math.round(share * (labels.length - 1)));
  };

  const hoveredShare = hovered === null ? 0 : xShare(hovered);
  const dimmed = (idx: number) => !area && pickedSeries !== null && pickedSeries !== idx;
  const tickLabel = (tick: number) => (!area && tick === ticks[ticks.length - 1] ? formatWithUnit(tick, unit) : formatNumber(tick));

  return (
    <div className={cn('flex flex-col gap-2', !inCard && 'oc-box')} dir="ltr">
      {title && <div className="typography-meta text-muted-foreground">{title}</div>}
      {area && end ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-semibold tabular-nums">
            <HeadlineUnit unit={unit} leading />
            {formatNumber(end.point)}
            <HeadlineUnit unit={unit} />
          </span>
          {changeText && firstIdx >= 0 && (
            <span className="typography-meta text-muted-foreground tabular-nums">
              {t('chat.uiBlock.chart.changeSince', { change: changeText, label: labels[firstIdx] })}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
          {series.map((item, idx) => (
            <button
              key={idx}
              type="button"
              aria-pressed={pickedSeries === idx}
              onClick={() => setPickedSeries((prev) => (prev === idx ? null : idx))}
              className={cn(
                'inline-flex items-center gap-1.5 transition-opacity hover:text-foreground',
                pickedSeries === idx && 'text-foreground font-medium',
                dimmed(idx) && 'opacity-40',
              )}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(idx) }} />
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 pt-2">
        <div className="relative h-[140px] typography-meta text-muted-foreground tabular-nums">
          {ticks.map((tick) => (
            <span key={tick} className="block whitespace-nowrap text-end leading-none opacity-0" aria-hidden="true">
              {tickLabel(tick)}
            </span>
          ))}
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute end-0 -translate-y-1/2 whitespace-nowrap leading-none"
              style={{ top: `${yShare(tick) * 100}%` }}
            >
              {tickLabel(tick)}
            </span>
          ))}
        </div>
        <div
          className="relative h-[140px] touch-pan-y"
          onPointerMove={pointAt}
          onPointerDown={pointAt}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setPointed(null);
          }}
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="absolute inset-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={width}
                y1={yShare(tick) * height}
                y2={yShare(tick) * height}
                stroke="var(--interactive-border)"
                strokeWidth={1}
                strokeOpacity={tick === 0 && !area ? 1 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {area && (
              <>
                <defs>
                  <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={seriesColor(0)} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={seriesColor(0)} stopOpacity={0} />
                  </linearGradient>
                </defs>
                {segmentsOf(singleValues).map((segment, segIdx) => (
                  <polygon
                    key={segIdx}
                    fill={`url(#${gradientId})`}
                    points={[
                      `${xShare(segment[0].index) * width},${height}`,
                      ...segment.map(({ index, point }) => `${xShare(index) * width},${yShare(point) * height}`),
                      `${xShare(segment[segment.length - 1].index) * width},${height}`,
                    ].join(' ')}
                  />
                ))}
              </>
            )}
            {hovered !== null && (
              <line
                x1={hoveredShare * width}
                x2={hoveredShare * width}
                y1={0}
                y2={height}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                strokeOpacity={0.6}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {series.map((item, seriesIndex) => (
              <g key={seriesIndex} opacity={dimmed(seriesIndex) ? 0.15 : 1}>
                {segmentsOf(item.values.slice(0, labels.length)).map((segment, segIdx) => (
                  <polyline
                    key={segIdx}
                    fill="none"
                    stroke={seriesColor(seriesIndex)}
                    strokeWidth={area ? 2.5 : 2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    points={segment.map(({ index, point }) => `${xShare(index) * width},${yShare(point) * height}`).join(' ')}
                  />
                ))}
              </g>
            ))}
          </svg>
          {series.map((item, seriesIndex) =>
            item.values.slice(0, labels.length).map((point, index) => {
              if (point === null) return null;
              const isEnd = end?.index === index;
              if (!isEnd && hovered !== index) return null;
              return (
                <span
                  key={`${seriesIndex}-${index}`}
                  className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--surface-elevated)]"
                  style={{
                    opacity: dimmed(seriesIndex) ? 0.15 : 1,
                    left: `${xShare(index) * 100}%`,
                    top: `${yShare(point) * 100}%`,
                    background: seriesColor(seriesIndex),
                  }}
                />
              );
            }),
          )}
          {hovered !== null && (
            <div
              className={cn(
                'pointer-events-none absolute top-0 z-10 flex flex-col gap-0.5 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 typography-meta shadow-md',
                hoveredShare > 0.5 ? '-translate-x-full -ms-2' : 'ms-2',
              )}
              style={{ left: `${hoveredShare * 100}%`, width: 'max-content' }}
            >
              <span className="font-medium">{labels[hovered]}</span>
              {series.map((item, seriesIndex) => {
                const point = item.values[hovered];
                return (
                  <span key={seriesIndex} className={cn('flex items-center gap-1.5', dimmed(seriesIndex) && 'opacity-40')}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(seriesIndex) }} />
                    {series.length > 1 && <span className="min-w-0 truncate text-muted-foreground">{item.name}</span>}
                    <span className="ms-auto ps-2 tabular-nums">
                      {point === null || point === undefined ? '–' : formatWithUnit(point, unit)}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <span />
        <div className="relative h-4 typography-meta text-muted-foreground">
          {axisLabels.map(({ label, index }) => {
            const edge = index === 0 ? 'translate-x-0' : index === labels.length - 1 ? '-translate-x-full' : '-translate-x-1/2';
            return (
              <span key={index} className={cn('absolute top-0 whitespace-nowrap', edge)} style={{ left: `${xShare(index) * 100}%` }}>
                {label}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
