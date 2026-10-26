import React from 'react';
import type {
  GuestStatusAction,
  GuestStatusActionEvent,
  GuestStatusChartUnit,
  GuestStatusChip,
  GuestStatusContent,
  GuestStatusRow,
  GuestStatusTone,
  GuestStatusView,
} from '@openchamber/sdk';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isGuestIconName } from '@/lib/guests/icon';
import { openGuestUrl } from '@/lib/guests/open-url';
import {
  createGuestStatusViewReader,
  postGuestStatusAction,
  startStatusViewPolling,
  type GuestStatusViewFailure,
  type StatusViewPoller,
} from '@/lib/guests/status-view';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { WorkStatusPill } from './WorkStatusPrimitives';

/**
 * Colours of a source section come from the theme only. `default` inherits
 * the row's text colour; the rest are the theme's own variables.
 */
const TONE_COLOR = {
  default: undefined,
  muted: 'var(--surface-muted-foreground)',
  accent: 'var(--primary)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  error: 'var(--status-error)',
  info: 'var(--status-info)',
} satisfies Record<GuestStatusTone, string | undefined>;

/** Fills and lines need a colour even for `default`. */
const strokeColor = (tone: GuestStatusTone | undefined): string => TONE_COLOR[tone ?? 'accent'] ?? 'var(--surface-foreground)';

const toneStyle = (tone: GuestStatusTone | undefined): React.CSSProperties | undefined => {
  const color = tone ? TONE_COLOR[tone] : undefined;
  return color ? { color } : undefined;
};

const pillStyle = (tone: GuestStatusTone | undefined) => {
  const color = tone ? TONE_COLOR[tone] : undefined;
  return color && tone !== 'muted' ? { color, background: `color-mix(in srgb, ${color} 18%, transparent)` } : {};
};

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const formatNumber = (value: number, digits: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(value);

/** The hover label's number, in the app's language like the rest of the panel. */
const formatPoint = (value: number, unit: GuestStatusChartUnit | undefined): string => {
  if (unit === 'percent') return `${formatNumber(value, value < 10 ? 1 : 0)}%`;
  if (unit === 'bytes') {
    let size = value;
    let index = 0;
    while (size >= 1024 && index < BYTE_UNITS.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${formatNumber(size, index === 0 ? 0 : 1)} ${BYTE_UNITS[index]}`;
  }
  return new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: 1 }).format(value);
};

// ----- Polling and actions -----

type ViewState = { view: GuestStatusView | null; failure: GuestStatusViewFailure | null };

const EMPTY_STATE: ViewState = { view: null, failure: null };

/**
 * Reads the section while it is mounted: the panel mounts it only while the
 * section is shown and expanded. The caller keys the body by guest and
 * directory, so a project change starts from an empty state.
 */
const useGuestStatusView = (guestId: string, path: string, interval: number, directory: string | null, locale: string) => {
  const [state, setState] = React.useState<ViewState>(EMPTY_STATE);
  const pollerRef = React.useRef<StatusViewPoller | null>(null);
  React.useEffect(() => {
    const poller = startStatusViewPolling({
      read: createGuestStatusViewReader(guestId, path, { directory, locale }),
      interval,
      onRead: (result) => setState((current) => {
        // An unchanged answer keeps the same view object, so nothing redraws.
        if (result.ok) return current.view === result.view && current.failure === null ? current : { view: result.view, failure: null };
        return current.failure === result.failure ? current : { view: current.view, failure: result.failure };
      }),
    });
    pollerRef.current = poller;
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [directory, guestId, interval, locale, path]);
  const refresh = React.useCallback(() => pollerRef.current?.refresh() ?? Promise.resolve(), []);
  return { ...state, refresh };
};

type ActionState = {
  /** Controls whose request is in flight. */
  busy: ReadonlySet<string>;
  /**
   * The value a choice was set to, shown until a view read after the service
   * answered, which then has the service's own word on it.
   */
  chosen: ReadonlyMap<string, string>;
  act: (event: GuestStatusActionEvent) => void;
  openUrl: (url: string) => void;
};

const ActionContext = React.createContext<ActionState | null>(null);

const useActions = (): ActionState => {
  const actions = React.useContext(ActionContext);
  if (!actions) throw new Error('Status view controls render inside GuestStatusViewBody');
  return actions;
};

// ----- Content -----

/**
 * The fill is the track's full width slid back by what is missing, so a new
 * sample glides to its value on the compositor and the rounded end keeps
 * its shape; the track clips the rest.
 */
const Bar: React.FC<{ value: number; tone?: GuestStatusTone }> = ({ value, tone }) => {
  const { direction } = useI18n();
  const missing = 100 - Math.max(0, Math.min(100, value));
  return (
    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--chat-divider)]">
      <div
        className="h-full rounded-full transition-transform duration-[400ms] ease-out"
        style={{ transform: `translateX(${direction === 'rtl' ? missing : -missing}%)`, backgroundColor: strokeColor(tone) }}
      />
    </div>
  );
};

const CHART_WIDTH = 100;
const CHART_HEIGHT = 16;

/**
 * A small area chart with the newest point at the right edge. The hover label
 * names the point under the pointer and how long ago it was taken.
 */
const Chart: React.FC<Extract<GuestStatusContent, { kind: 'chart' }>> = ({ values, max, tone, unit, step }) => {
  const { t } = useI18n();
  const [hovered, setHovered] = React.useState<number | null>(null);
  const top = max ?? Math.max(1, ...values);
  const color = strokeColor(tone);
  const x = (index: number) => (values.length < 2 ? CHART_WIDTH : (index / (values.length - 1)) * CHART_WIDTH);
  const y = (value: number) => CHART_HEIGHT - 1 - (Math.min(value, top) / top) * (CHART_HEIGHT - 2);
  const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(' ');
  const point = hovered === null ? undefined : values[hovered];
  const ago = hovered === null ? 0 : Math.round((values.length - 1 - hovered) * (step ?? 0));
  const label = point === undefined
    ? null
    : ago === 0
      ? t('chat.workStatus.guestView.pointNow', { value: formatPoint(point, unit) })
      : t('chat.workStatus.guestView.pointAgo', { value: formatPoint(point, unit), seconds: String(ago) });
  return (
    <Tooltip open={label !== null}>
      <TooltipTrigger asChild>
        {/* Time runs left to right in every language. */}
        <div
          dir="ltr"
          className="h-4 min-w-0 flex-1"
          onPointerMove={(event) => {
            if (values.length === 0) return;
            const box = event.currentTarget.getBoundingClientRect();
            const share = box.width > 0 ? (event.clientX - box.left) / box.width : 1;
            setHovered(Math.max(0, Math.min(values.length - 1, Math.round(share * (values.length - 1)))));
          }}
          onPointerLeave={() => setHovered(null)}
        >
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden="true">
            {values.length > 0 ? (
              <>
                <path d={`${line} L${CHART_WIDTH} ${CHART_HEIGHT} L${x(0).toFixed(2)} ${CHART_HEIGHT} Z`} fill={`color-mix(in srgb, ${color} 18%, transparent)`} />
                <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </>
            ) : null}
          </svg>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <span dir="auto" className="tabular-nums">{label}</span>
      </TooltipContent>
    </Tooltip>
  );
};

const Chip: React.FC<{ chip: GuestStatusChip }> = ({ chip }) => {
  const { openUrl } = useActions();
  const className = 'shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 tabular-nums';
  const fallback = !chip.tone || chip.tone === 'default' || chip.tone === 'muted';
  if (!chip.url) {
    return <span dir="auto" className={cn(className, fallback && 'bg-[var(--interactive-hover)] text-muted-foreground')} style={pillStyle(chip.tone)}>{chip.label}</span>;
  }
  const url = chip.url;
  return (
    <button
      type="button"
      title={url}
      onClick={() => openUrl(url)}
      dir="auto"
      className={cn(className, 'transition-opacity hover:opacity-80', fallback && 'bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground')}
      style={pillStyle(chip.tone)}
    >
      {chip.label}
    </button>
  );
};

const Segmented: React.FC<Extract<GuestStatusContent, { kind: 'segmented' }>> = ({ id, label, value, options, disabled }) => {
  const { busy, chosen, act } = useActions();
  const current = chosen.get(id) ?? value;
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-1 items-center gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          variant="chip"
          size="xs"
          aria-pressed={option.value === current}
          disabled={disabled || busy.has(id)}
          onClick={() => { if (option.value !== current) act({ id, value: option.value }); }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
};

const Content: React.FC<{ content: GuestStatusContent }> = ({ content }) => {
  switch (content.kind) {
    case 'bar':
      return <Bar value={content.value} tone={content.tone} />;
    case 'chart':
      return <Chart {...content} />;
    case 'chips':
      return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{content.chips.map((chip) => <Chip key={chip.id} chip={chip} />)}</div>;
    case 'text':
      return <span dir="auto" className="min-w-0 flex-1 truncate" style={toneStyle(content.tone)}>{content.text}</span>;
    case 'segmented':
      return <Segmented {...content} />;
  }
};

// ----- Actions -----

const CONFIRM_MS = 4_000;

const ActionButton: React.FC<Extract<GuestStatusAction, { kind: 'button' }>> = ({ id, label, variant, confirm, disabled }) => {
  const { busy, act } = useActions();
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      variant={variant === 'outline' ? 'outline' : variant === 'destructive' ? 'destructive' : 'ghost'}
      size="xs"
      disabled={disabled || busy.has(id)}
      aria-busy={busy.has(id) || undefined}
      onClick={() => {
        if (confirm && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        act({ id });
      }}
      className="max-w-[8rem]"
    >
      <span className="truncate">{armed && confirm ? confirm : label}</span>
    </Button>
  );
};

const ActionSwitch: React.FC<Extract<GuestStatusAction, { kind: 'switch' }>> = ({ id, label, checked, disabled }) => {
  const { busy, chosen, act } = useActions();
  const choice = chosen.get(id);
  const current = choice === undefined ? checked : choice === 'on';
  return (
    <Switch
      aria-label={label}
      checked={current}
      disabled={disabled || busy.has(id)}
      loading={busy.has(id)}
      onCheckedChange={(next) => act({ id, value: next ? 'on' : 'off' })}
    />
  );
};

const ActionSelect: React.FC<Extract<GuestStatusAction, { kind: 'select' }>> = ({ id, label, value, options, disabled }) => {
  const { busy, chosen, act } = useActions();
  const current = chosen.get(id) ?? value;
  const selected = options.find((option) => option.value === current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={`${label}: ${selected?.label ?? current}`} disabled={disabled || busy.has(id)} className="max-w-[8rem] gap-1">
          <span className="min-w-0 truncate">{selected?.label ?? current}</span>
          <Icon name="arrow-down-s" className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-work-status-popup align="end" className="min-w-32">
        <DropdownMenuRadioGroup value={current} onValueChange={(next) => { if (next !== current) act({ id, value: next }); }}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="truncate">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const Action: React.FC<{ action: GuestStatusAction }> = ({ action }) => {
  switch (action.kind) {
    case 'button':
      return <ActionButton {...action} />;
    case 'switch':
      return <ActionSwitch {...action} />;
    case 'select':
      return <ActionSelect {...action} />;
  }
};

// ----- Rows -----

const NOTE_TONE = {
  info: { color: 'var(--status-info)', background: 'var(--status-info-background)' },
  warning: { color: 'var(--status-warning)', background: 'var(--status-warning-background)' },
  error: { color: 'var(--status-error)', background: 'var(--status-error-background)' },
} satisfies Record<'info' | 'warning' | 'error', { color: string; background: string }>;

const Note: React.FC<{ text: string; tone?: 'muted' | 'info' | 'warning' | 'error' }> = ({ text, tone = 'muted' }) => (
  tone === 'muted'
    ? <p dir="auto" className="px-1 py-1 text-xs text-muted-foreground">{text}</p>
    // A tinted fill already says what kind of note it is, so it draws no border.
    : <p dir="auto" className="mx-1 mb-1 rounded-md px-2 py-1.5 text-xs" style={{ color: NOTE_TONE[tone].color, backgroundColor: NOTE_TONE[tone].background }}>{text}</p>
);

const RowTooltip: React.FC<{ text: string; children: React.ReactElement }> = ({ text, children }) => (
  // Above the row, as on every dense row, so it never covers the rows under it.
  <Tooltip delayDuration={300}>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top" sideOffset={4} className="max-w-[min(320px,calc(100vw-24px))] whitespace-normal break-words text-start">
      {text}
    </TooltipContent>
  </Tooltip>
);

const Line: React.FC<{ row: Extract<GuestStatusRow, { kind: 'line' }> }> = ({ row }) => {
  // An icon the app does not have is left out rather than replaced.
  const icon = row.icon && isGuestIconName(row.icon) ? row.icon : null;
  // A chart has its own hover label, so the row's tooltip moves to the label.
  const labelTooltip = row.tooltip && row.content?.kind === 'chart' ? row.tooltip : null;
  const rowTooltip = labelTooltip ? null : row.tooltip ?? null;
  const label = (
    // With something in the middle the label takes a column of its own, so contents line up row under row.
    <span dir="auto" tabIndex={labelTooltip ? 0 : undefined} className={cn('min-w-0 truncate', row.content ? 'w-24 shrink-0' : 'flex-1')}>{row.label}</span>
  );
  const body = (
    <div className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-start text-[13px] text-muted-foreground" tabIndex={rowTooltip ? 0 : undefined}>
      {row.dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: strokeColor(row.dot) }} /> : null}
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      {labelTooltip ? <RowTooltip text={labelTooltip}>{label}</RowTooltip> : label}
      {row.content ? <Content content={row.content} /> : null}
      {row.badge ? <WorkStatusPill {...pillStyle(row.badge.tone)}>{row.badge.label}</WorkStatusPill> : null}
      {row.value ? <span dir="auto" className="shrink-0 tabular-nums" style={toneStyle(row.valueTone)}>{row.value}</span> : null}
      {row.actions?.map((action) => <Action key={action.id} action={action} />)}
    </div>
  );
  return rowTooltip ? <RowTooltip text={rowTooltip}>{body}</RowTooltip> : body;
};

/** Rows keep their objects while unchanged (`createGuestStatusViewReader`), so memo skips them. */
const Row = React.memo<{ row: GuestStatusRow }>(({ row }) => (
  row.kind === 'note' ? <Note text={row.text} tone={row.tone} /> : <Line row={row} />
));
Row.displayName = 'GuestStatusRow';

// ----- Section body -----

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_CHOICES: ReadonlyMap<string, string> = new Map();

/**
 * The body of a source section. Reads the extension's service, draws its rows
 * and hands the header controls to the section through `onStatusControls`,
 * the same binding a status frame uses.
 */
export const GuestStatusViewBody: React.FC<{
  guestId: string;
  source: { path: string; interval: number };
  directory: string | null;
  onStatusControls: (binding: GuestStatusControlBinding | null) => void;
}> = ({ guestId, source, directory, onStatusControls }) => {
  const { t, locale } = useI18n();
  const { view, failure, refresh } = useGuestStatusView(guestId, source.path, source.interval, directory, locale);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(EMPTY_SET);
  const [chosen, setChosen] = React.useState<ReadonlyMap<string, string>>(EMPTY_CHOICES);

  const act = React.useCallback((event: GuestStatusActionEvent) => {
    setBusy((current) => new Set(current).add(event.id));
    if (event.value !== undefined) {
      const value = event.value;
      setChosen((current) => new Map(current).set(event.id, value));
    }
    const forget = () => setChosen((current) => {
      if (!current.has(event.id)) return current;
      const next = new Map(current);
      next.delete(event.id);
      return next;
    });
    void postGuestStatusAction(guestId, source.path, { directory, locale }, event).then(async (result) => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(event.id);
        return next;
      });
      if (!result.ok) {
        forget();
        toast.error(result.message ?? t('chat.workStatus.guestView.actionFailed'));
        void refresh();
        return;
      }
      // A read already under way may predate the action; the choice stays
      // until one that started after the answer is on screen.
      await refresh();
      forget();
    });
  }, [directory, guestId, locale, refresh, source.path, t]);

  const openUrl = React.useCallback((url: string) => {
    void openGuestUrl(url, directory, true);
  }, [directory]);

  // The header shows a choice at once and holds a control while its request runs, like the rows.
  const viewControls = view?.controls;
  const controls = React.useMemo(() => viewControls?.map((control) => {
    const disabled = control.disabled || busy.has(control.id);
    return control.kind === 'select'
      ? { ...control, value: chosen.get(control.id) ?? control.value, disabled }
      : { ...control, disabled };
  }), [busy, chosen, viewControls]);
  React.useEffect(() => {
    onStatusControls(controls && controls.length > 0 ? { controls, dispatch: act } : null);
  }, [act, controls, onStatusControls]);
  React.useEffect(() => () => onStatusControls(null), [onStatusControls]);

  const actions = React.useMemo<ActionState>(() => ({ busy, chosen, act, openUrl }), [act, busy, chosen, openUrl]);

  if (!view) {
    return failure
      ? <Note text={t(failure === 'invalid' ? 'chat.workStatus.guestView.invalid' : 'chat.workStatus.guestView.unreachable')} tone="error" />
      : <p className="flex items-center px-1 py-1 text-xs text-muted-foreground">{t('chat.workStatus.guestView.reading')}<BusyDots /></p>;
  }
  return (
    <ActionContext.Provider value={actions}>
      {failure ? <Note text={t(failure === 'invalid' ? 'chat.workStatus.guestView.invalid' : 'chat.workStatus.guestView.unreachable')} tone="error" /> : null}
      {/* The last view stays for reference, faded, while the service does not answer. */}
      <div className={cn('flex flex-col', failure && 'opacity-60')}>
        {view.rows.length === 0
          ? <Note text={t('chat.workStatus.guestView.empty')} />
          : view.rows.map((row) => <Row key={row.id} row={row} />)}
      </div>
    </ActionContext.Provider>
  );
};
