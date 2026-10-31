import React from 'react';
import type { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { Button as UiButton } from '@/components/ui/button';
import { Input as UiInput } from '@/components/ui/input';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MarkdownContent } from '../MarkdownRendererImpl';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { blockDecisions, blockFields, blockName, blockNode, blockProps, parseUiBlock, type BlockName, type BlockValue, tones } from './catalog';
import {
  describeUiBlockAnswer,
  describeUiBlockReplyAnswer,
  type UiBlockAnswer,
  type UiBlockAnswerData,
  type UiBlockFieldValue,
  type UiBlockReplyAnswerData,
} from './answer';

/**
 * Where a block's answer goes. Without `submit` the fields and buttons show
 * but do nothing (a reply still streaming, a page that no longer waits);
 * `answered` restores an answer already given.
 *
 * - `page`: a block an agent waits on. A press answers that call at once.
 * - `reply`: a block in a finished reply. Presses only choose, one button per
 *   decision; once every decision has a choice, or the user sends what they
 *   chose, the choices go to the agent in one piece and start its next turn.
 */
export type UiBlockHost =
  | { kind: 'page'; submit: ((answer: UiBlockAnswer) => Promise<void>) | null; answered: UiBlockAnswerData | null }
  | {
    kind: 'reply';
    submit: ((answer: UiBlockReplyAnswerData, text: string) => Promise<void>) | null;
    answered: UiBlockReplyAnswerData | null;
  };

const noHost: UiBlockHost = { kind: 'reply', submit: null, answered: null };

/** The chosen button per decision; a decision is the value its buttons share. */
type Chosen = ReadonlyMap<string, string>;

const chosenFrom = (host: UiBlockHost): Chosen => {
  if (!host.answered) return new Map();
  if (host.kind === 'page') return new Map([[host.answered.value ?? '', host.answered.button]]);
  return new Map(host.answered.picks.map((pick) => [pick.value ?? '', pick.button]));
};

type FormState = {
  values: Record<string, UiBlockFieldValue>;
  setValue: (name: string, value: UiBlockFieldValue) => void;
  press: (button: string, value?: string) => void;
  disabled: boolean;
  chosen: Chosen;
};

const FormContext = React.createContext<FormState>({ values: {}, setValue: () => {}, press: () => {}, disabled: true, chosen: new Map() });

/**
 * Draws one `openui-lang` block of an assistant reply. Every node reads its
 * props through its component's schema. While the block streams, a node's
 * props can be cut mid-value; it then keeps drawing its last props that
 * parsed, and a node that never parsed yet draws nothing.
 */

type Tone = (typeof tones)[number];
type NodeProps = { props: BlockValue };

const toneText = {
  neutral: 'text-muted-foreground',
  info: 'text-[var(--status-info)]',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
} satisfies Record<Tone, string>;
const toneFill = {
  neutral: 'oc-tile',
  info: 'bg-[var(--status-info-background)]',
  success: 'bg-[var(--status-success-background)]',
  warning: 'bg-[var(--status-warning-background)]',
  error: 'bg-[var(--status-error-background)]',
} satisfies Record<Tone, string>;

// A table inside a card drops its frame, so no box sits in a box.
const InCardContext = React.createContext(false);

const seriesColor = (index: number) => `var(--chart-${(index % 5) + 1})`;
const formatValue = (value: number, unit = '') => `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ''}`;

function useBlockProps<S extends z.ZodType>(schema: S, props: BlockValue): z.infer<S> | null {
  const parsed = schema.safeParse(props);
  const last = React.useRef<z.infer<S> | null>(null);
  if (parsed.success) last.current = parsed.data;
  return last.current;
}

// A block draws in a reply and on a page an agent showed, so it reads the
// directory itself instead of the reply's Markdown context.
function Markdown({ source }: { source?: string }) {
  const directory = useEffectiveDirectory() ?? '';
  if (!source) return null;
  return <MarkdownContent content={source} mode="static" settled directory={directory} className="oc-ui-block-text" />;
}

function Children({ nodes }: { nodes: BlockValue[] }) {
  return <>{nodes.map((child, index) => <Node key={index} value={child} />)}</>;
}

function Stack({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Stack, props);
  return value && <div className="flex flex-col gap-3"><Children nodes={value.children} /></div>;
}

function Row({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Row, props);
  // Cards, tables and charts share the row's width; badges and buttons keep their own.
  return value && <div className="flex flex-wrap items-start gap-x-3 gap-y-2 [&>div]:min-w-[12rem] [&>div]:flex-1"><Children nodes={value.children} /></div>;
}

function Card({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Card, props);
  if (!value) return null;
  return (
    <div className="oc-tile flex flex-col gap-2 rounded-xl px-3 py-2.5">
      {value.title && <div className="font-medium">{value.title}</div>}
      <InCardContext.Provider value><Children nodes={value.children} /></InCardContext.Provider>
    </div>
  );
}

function Text({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Text, props);
  return value && <Markdown source={value.markdown} />;
}

function Badge({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Badge, props);
  if (!value) return null;
  return (
    <span className={cn('oc-tile-inset inline-flex w-fit items-center rounded-md px-1.5 typography-meta', toneText[value.tone ?? 'neutral'])}>
      {value.label}
    </span>
  );
}

function Callout({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Callout, props);
  if (!value) return null;
  const tone = value.tone ?? 'neutral';
  const icon = tone === 'error' || tone === 'warning' ? 'error-warning' : tone === 'success' ? 'checkbox-circle' : 'information';
  return (
    <div className={cn('flex gap-2 rounded-xl px-3 py-2', toneFill[tone])}>
      <Icon name={icon} className={cn('mt-[3px] size-4 shrink-0', toneText[tone])} />
      <div className="min-w-0 flex-1">
        {value.title && <div className="font-medium">{value.title}</div>}
        <Markdown source={value.markdown} />
      </div>
    </div>
  );
}

function KeyValue({ props }: NodeProps) {
  const value = useBlockProps(blockProps.KeyValue, props);
  if (!value) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
      {value.items.map((item, index) => (
        <React.Fragment key={index}>
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="m-0 tabular-nums">{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function Table({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Table, props);
  const inCard = React.useContext(InCardContext);
  if (!value) return null;
  // The reply's own table look (`data-streamdown` styles in index.css).
  return (
    <div data-streamdown="table-wrapper">
      <div className={cn('min-w-0 overflow-x-auto', inCard && '!border-0 !bg-transparent')}>
        <table data-streamdown="table">
          <thead data-streamdown="table-header">
            <tr data-streamdown="table-row">
              {value.columns.map((column, index) => <th key={index} data-streamdown="table-header-cell">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-streamdown="table-row">
                {value.columns.map((_, cellIndex) => {
                  const cell = row[cellIndex] ?? '';
                  return (
                    <td key={cellIndex} data-streamdown="table-cell" className={Number.isFinite(cell) ? 'tabular-nums text-end' : undefined}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type StepStatus = z.infer<typeof blockProps.Steps>['items'][number]['status'];

function StepMark({ status, index }: { status: StepStatus; index: number }) {
  if (status === 'done') return <Icon name="checkbox-circle" className="size-4 shrink-0 text-[var(--status-success)]" />;
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full typography-micro tabular-nums',
        status === 'current' ? 'bg-[var(--status-info)] text-[var(--status-info-foreground)]' : 'oc-tile-inset text-muted-foreground',
      )}
    >
      {index + 1}
    </span>
  );
}

function Steps({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Steps, props);
  if (!value) return null;
  if (value.direction === 'row') {
    return (
      <div className="flex flex-wrap items-stretch gap-1.5">
        {value.items.map((item, index) => (
          <React.Fragment key={index}>
            {index > 0 && <Icon name="arrow-right-s" className="size-4 shrink-0 self-center text-muted-foreground" />}
            <div className="oc-tile flex min-w-[8rem] flex-1 flex-col gap-1 rounded-xl px-3 py-2">
              <div className="flex items-center gap-1.5 font-medium"><StepMark status={item.status} index={index} />{item.title}</div>
              <Markdown source={item.markdown} />
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {value.items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-[3px]"><StepMark status={item.status} index={index} /></span>
          <div className="min-w-0 flex-1">
            <div className={cn('font-medium', item.status === 'todo' && 'text-muted-foreground')}>{item.title}</div>
            <Markdown source={item.markdown} />
          </div>
        </li>
      ))}
    </ol>
  );
}

type Series = z.infer<typeof blockProps.Series>;

/** Series that have arrived whole; a streaming one joins once it parses. */
const seriesOf = (nodes: BlockValue[]): Series[] => nodes.flatMap((node) => {
  const series = blockProps.Series.safeParse(blockNode.safeParse(node).data?.props);
  return series.success ? [series.data] : [];
});

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 typography-meta text-muted-foreground">
      {series.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: seriesColor(index) }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars: long category labels stay readable on a phone. */
function BarChart({ props }: NodeProps) {
  const value = useBlockProps(blockProps.BarChart, props);
  if (!value) return null;
  const series = seriesOf(value.series);
  const max = Math.max(0, ...series.flatMap((item) => item.values));
  return (
    <div className="flex flex-col gap-2">
      <Legend series={series} />
      <div className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {value.labels.map((label, labelIndex) => (
          <React.Fragment key={labelIndex}>
            <span className="truncate typography-meta text-muted-foreground" title={label}>{label}</span>
            <div className="flex flex-col gap-0.5">
              {series.map((item, seriesIndex) => {
                const point = item.values[labelIndex];
                if (point === undefined) return null;
                return (
                  <div key={seriesIndex} className="flex items-center gap-2">
                    <div
                      className="h-2.5 rounded-sm"
                      style={{ width: max > 0 ? `${Math.max(0, point / max) * 85}%` : 0, background: seriesColor(seriesIndex) }}
                    />
                    <span className="shrink-0 typography-meta tabular-nums">{formatValue(point, value.unit)}</span>
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function LineChart({ props }: NodeProps) {
  const value = useBlockProps(blockProps.LineChart, props);
  if (!value) return null;
  const { labels } = value;
  const series = seriesOf(value.series);
  const values = series.flatMap((item) => item.values);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const width = 600;
  const height = 140;
  const span = max - min || 1;
  const x = (index: number) => (labels.length < 2 ? width / 2 : (index / (labels.length - 1)) * width);
  const y = (point: number) => height - ((point - min) / span) * height;
  const axisLabels = [labels[0], labels.length > 2 ? labels[Math.floor((labels.length - 1) / 2)] : undefined, labels.length > 1 ? labels[labels.length - 1] : undefined]
    .filter((label) => label !== undefined);
  // Time runs left to right in every UI language, so the plot and its labels stay LTR.
  return (
    <div className="flex flex-col gap-2" dir="ltr">
      <Legend series={series} />
      {/* The scale sits over the plot's start edge, so the plot and the labels under it share one width. */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 start-0 flex flex-col justify-between typography-meta text-muted-foreground tabular-nums">
          <span>{formatValue(max, value.unit)}</span>
          <span>{formatValue(min, value.unit)}</span>
        </div>
        <svg viewBox={`-4 -4 ${width + 8} ${height + 8}`} className="h-[140px] w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
          <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--interactive-border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {series.map((item, seriesIndex) => (
            <polyline
              key={seriesIndex}
              fill="none"
              stroke={seriesColor(seriesIndex)}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              points={item.values.slice(0, labels.length).map((point, index) => `${x(index)},${y(point)}`).join(' ')}
            />
          ))}
        </svg>
      </div>
      <div className="flex justify-between gap-2 typography-meta text-muted-foreground">
        {axisLabels.map((label, index) => <span key={index} className="truncate">{label}</span>)}
      </div>
    </div>
  );
}

function Tabs({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Tabs, props);
  const [active, setActive] = React.useState('0');
  if (!value) return null;
  const tabs = value.tabs.flatMap((node) => {
    const tab = blockProps.Tab.safeParse(blockNode.safeParse(node).data?.props);
    return tab.success ? [tab.data] : [];
  });
  const activeIndex = Number(active) < tabs.length ? Number(active) : 0;
  const current = tabs[activeIndex];
  return (
    <div className="flex flex-col gap-2">
      <SortableTabsStrip
        items={tabs.map((tab, index) => ({ id: String(index), label: tab.label }))}
        activeId={current ? String(activeIndex) : null}
        onSelect={setActive}
        variant="active-pill"
        layoutMode="scrollable"
        intrinsicWidth
        pillSize="toolbar"
        className="h-7 max-w-full flex-none self-start"
      />
      {current && <div className="flex flex-col gap-3"><Children nodes={current.children} /></div>}
    </div>
  );
}

function FieldLabel({ label, children }: { label?: string; children: React.ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <label className="flex flex-col gap-1">
      <span className="typography-ui-label text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Choice({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Choice, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const current = form.values[value.name];
  const chosen = Array.isArray(current) ? current : current ? [current] : [];
  const toggle = (option: string) => {
    if (!value.multiple) {
      form.setValue(value.name, option);
      return;
    }
    form.setValue(value.name, chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option]);
  };
  return (
    <div className="flex flex-col gap-1">
      {value.label && <span className="typography-ui-label text-muted-foreground">{value.label}</span>}
      <div className="flex flex-wrap gap-1.5" role={value.multiple ? 'group' : 'radiogroup'} aria-label={value.label || value.name}>
        {value.options.map((option) => (
          <UiButton
            key={option}
            type="button"
            variant="chip"
            size="sm"
            aria-pressed={chosen.includes(option)}
            disabled={form.disabled}
            onClick={() => toggle(option)}
          >
            {option}
          </UiButton>
        ))}
      </div>
    </div>
  );
}

function Input({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Input, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const current = form.values[value.name];
  const text = Array.isArray(current) ? current.join(', ') : current ?? '';
  const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => form.setValue(value.name, event.target.value);
  return (
    <FieldLabel label={value.label}>
      {value.multiline
        ? <Textarea value={text} placeholder={value.placeholder} disabled={form.disabled} onChange={onChange} rows={3} />
        : <UiInput value={text} placeholder={value.placeholder} disabled={form.disabled} onChange={onChange} />}
    </FieldLabel>
  );
}

function Button({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Button, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const chosen = form.chosen.get(value.value ?? '') === value.label;
  return (
    <UiButton
      type="button"
      variant={value.variant === 'secondary' ? 'outline' : 'default'}
      className="w-fit"
      aria-pressed={chosen}
      disabled={form.disabled}
      onClick={() => form.press(value.label, value.value)}
    >
      {chosen && <Icon name="check" className="size-3.5" />}
      {value.label}
    </UiButton>
  );
}

// Tab and Series draw inside their parents.
const renderers = {
  Stack, Row, Card, Tabs, Text, Badge, Callout, KeyValue, Table, Steps, BarChart, LineChart, Choice, Input, Button,
} satisfies Partial<Record<BlockName, React.FC<NodeProps>>>;
const drawn = blockName.extract([
  'Stack', 'Row', 'Card', 'Tabs', 'Text', 'Badge', 'Callout', 'KeyValue', 'Table', 'Steps', 'BarChart', 'LineChart',
  'Choice', 'Input', 'Button',
]);

function Node({ value }: { value: BlockValue }) {
  const node = blockNode.safeParse(value);
  const name = drawn.safeParse(node.data?.typeName);
  if (!node.success || !name.success) return null;
  const Renderer = renderers[name.data];
  return <Renderer props={node.data.props} />;
}

/**
 * A block that fails to draw shows its source. The next source text clears
 * the failure without remounting a working tree, so a streamed update keeps
 * the user's chosen tab.
 */
class BlockErrorBoundary extends React.Component<
  { source: string; fallback: React.ReactNode; onFailed?: (errors: string[]) => void; children: React.ReactNode },
  { failed: boolean; source: string }
> {
  state = { failed: false, source: this.props.source };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onFailed?.([`The chat failed to draw this block: ${error.message}`]);
  }

  static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
    return props.source !== state.source ? { source: props.source, failed: false } : null;
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function UiBlock({ source, complete, host = noHost, onNotDrawn }: {
  source: string;
  complete: boolean;
  host?: UiBlockHost;
  /** Hears why a finished block could not be drawn: the parser's errors, or a drawing failure. */
  onNotDrawn?: (errors: string[]) => void;
}) {
  const { t } = useI18n();
  const parsed = React.useMemo(() => parseUiBlock(source, complete), [source, complete]);
  const notDrawnErrors = parsed.kind === 'invalid' ? parsed.errors : null;
  React.useEffect(() => {
    if (notDrawnErrors) onNotDrawn?.(notDrawnErrors);
  }, [notDrawnErrors, onNotDrawn]);
  const [values, setValues] = React.useState<Record<string, UiBlockFieldValue>>(() => host.answered?.values ?? {});
  const [chosen, setChosen] = React.useState<Chosen>(() => chosenFrom(host));
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(host.answered !== null);
  const [failed, setFailed] = React.useState(false);
  // An answer stored after this block mounted (given on another device, or
  // read back after a reload) shows here too and freezes the block.
  const [shownAnswer, setShownAnswer] = React.useState(host.answered);
  if (host.answered !== shownAnswer) {
    setShownAnswer(host.answered);
    if (host.answered) {
      setValues(host.answered.values);
      setChosen(chosenFrom(host));
      setSent(true);
    }
  }
  const root = parsed.kind === 'ready' ? parsed.root : null;
  const fields = React.useMemo(() => (root && complete ? blockFields(root) : []), [root, complete]);
  const decisions = React.useMemo(() => (root ? blockDecisions(root) : []), [root]);
  const disabled = !host.submit || !complete || sending || sent;

  const deliver = React.useCallback((send: () => Promise<void>) => {
    setSending(true);
    setFailed(false);
    send().then(() => setSent(true), () => setFailed(true)).finally(() => setSending(false));
  }, []);
  const sendReply = React.useCallback((choices: Chosen) => {
    if (host.kind !== 'reply' || !host.submit) return;
    const { submit } = host;
    const answer: UiBlockReplyAnswerData = {
      picks: decisions.flatMap((decision) => {
        const button = choices.get(decision);
        return button === undefined ? [] : [decision ? { button, value: decision } : { button }];
      }),
      values,
      skipped: decisions.filter((decision) => !choices.has(decision)),
    };
    deliver(() => submit(answer, describeUiBlockReplyAnswer(fields, answer)));
  }, [host, decisions, values, fields, deliver]);

  const form = React.useMemo<FormState>(() => ({
    values,
    disabled,
    chosen,
    setValue: (name, value) => setValues((previous) => ({ ...previous, [name]: value })),
    press: (button, value) => {
      if (disabled) return;
      const decision = value ?? '';
      if (host.kind === 'page') {
        if (!host.submit) return;
        const { submit } = host;
        const data = value ? { button, value, values } : { button, values };
        setChosen(new Map([[decision, button]]));
        deliver(() => submit({ summary: describeUiBlockAnswer(fields, data), data }));
        return;
      }
      // A press chooses; pressing the chosen button again clears the choice.
      const next = new Map(chosen);
      if (next.get(decision) === button) next.delete(decision);
      else next.set(decision, button);
      setChosen(next);
      if (decisions.every((item) => next.has(item))) sendReply(next);
    },
  }), [values, disabled, chosen, host, fields, decisions, deliver, sendReply]);
  // Sending what is chosen so far, or again after a failed send.
  const canSendChosen = host.kind === 'reply' && !sent && chosen.size > 0 && (chosen.size < decisions.length || failed);
  const fallback = (
    <div className="flex flex-col gap-1">
      <div className="typography-meta text-[var(--status-error)]">{t('chat.uiBlock.invalid')}</div>
      <pre dir="ltr"><code>{source}</code></pre>
    </div>
  );
  if (parsed.kind === 'invalid') return fallback;
  if (parsed.kind === 'empty') return null;
  // A block that fails to draw falls back to its source; the rest of the reply stays.
  return (
    <div data-oc-ui-block="" className="oc-ui-block my-3">
      <BlockErrorBoundary source={source} fallback={fallback} onFailed={onNotDrawn}>
        <FormContext.Provider value={form}>
          <Node value={parsed.root} />
        </FormContext.Provider>
      </BlockErrorBoundary>
      {/* A block that sends keeps one line for what happened, so the reply does not jump. */}
      {decisions.length > 0 && host.kind === 'reply' && (host.submit || sent) ? (
        <div className="mt-1 flex min-h-6 items-center gap-2 typography-meta text-muted-foreground" aria-live="polite" data-export-ignore>
          {failed ? <span className="text-[var(--status-error)]">{t('chat.uiBlock.sendFailed')}</span>
            : sent ? <span>{t('chat.uiBlock.sent')}</span>
              : chosen.size > 0 && decisions.length > 1
                ? <span>{t('chat.uiBlock.chosenCount', { count: chosen.size, total: decisions.length })}</span>
                : null}
          {canSendChosen ? (
            <UiButton type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => sendReply(chosen)}>
              {t('chat.uiBlock.sendChosen')}
            </UiButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
