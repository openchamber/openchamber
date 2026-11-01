import React from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { Button as UiButton } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { DatePicker, TimePill } from '@/components/ui/date-time';
import { Input as FieldInput } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useCalendarPreferences } from '@/components/ui/useCalendarPreferences';
import { useI18n } from '@/lib/i18n';
import { KIT_SHARED_CSS, kitVariables, seriesColor } from '../lib/visualKit';
import { cn } from '@/lib/utils';
import { MarkdownContent } from '../MarkdownRenderer';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { axisTicks } from './axisTicks';
import {
  blockDecisions, blockFields, cardDecision, choiceOption, DEFAULT_TIME, decisionOf, decisionTitles, blockName, blockNode, blockPath, blockProps, noteSlot, parseUiBlock, sliderStart, type BlockName, type BlockPath, type BlockValue, tones,
} from './catalog';
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

/**
 * The answer per decision; a decision is the value its buttons share. A
 * decision answered with its note alone has no button (null).
 */
type Chosen = ReadonlyMap<string, string | null>;
/** The user's note per decision, on a card in a reply. */
type Notes = ReadonlyMap<string, string>;

const chosenFrom = (host: UiBlockHost): Chosen => {
  if (!host.answered) return new Map();
  if (host.kind === 'page') return new Map([[host.answered.value ?? '', host.answered.button]]);
  return new Map(host.answered.picks.map((pick) => [pick.value ?? '', pick.button ?? null]));
};

const notesFrom = (host: UiBlockHost): Notes => (host.kind === 'reply' && host.answered
  ? new Map(host.answered.picks.flatMap((pick) => (pick.note ? [[pick.value ?? '', pick.note]] : [])))
  : new Map());

type FormState = {
  values: Record<string, UiBlockFieldValue>;
  setValue: (name: string, value: UiBlockFieldValue) => void;
  press: (button: string, value?: string) => void;
  disabled: boolean;
  chosen: Chosen;
  /** A reply's decision cards fold once answered and take a note each. */
  folds: boolean;
  /** The card titles that name a decision (`decisionTitles`). */
  titles: ReadonlySet<string>;
  notes: Notes;
  setNote: (decision: string, note: string) => void;
  /** Answers a decision with its note and no button. */
  answerWithNote: (decision: string) => void;
  /** Clears a decision's answer, so its card opens again. */
  reopen: (decision: string) => void;
};

const FormContext = React.createContext<FormState>({
  values: {},
  setValue: () => {},
  press: () => {},
  disabled: true,
  chosen: new Map(),
  folds: false,
  titles: new Set(),
  notes: new Map(),
  setNote: () => {},
  answerWithNote: () => {},
  reopen: () => {},
});

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

// Grouped for reading, never rounded: a table or a stat shows the value the agent gave.
// Groups split by a narrow space in every UI language: the agent writes in
// its own language, and "2,318" next to its "184 200" read as two formats.
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });
const formatNumber = (value: number) => numberFormat.format(value).replace(/,/g, ' ');
/** A chart's unit follows its number, so "126 k" or "42%" reads as one value. */
const unitSuffix = (unit?: string) => (!unit ? '' : /^[%°]/.test(unit) ? unit : ` ${unit}`);
// Dollars and pounds are written before the amount.
const unitLeads = (unit?: string) => unit === '$' || unit === '£';
const formatWithUnit = (value: number, unit?: string) => (unitLeads(unit) ? `${unit}${formatNumber(value)}` : `${formatNumber(value)}${unitSuffix(unit)}`);
const number = z.number();
/** A value as the reader sees it: numbers grouped, text as written. */
const display = (value: string | number) => {
  const parsed = number.safeParse(value);
  return parsed.success ? formatNumber(parsed.data) : String(value);
};

function useBlockProps<S extends z.ZodType>(schema: S, props: BlockValue): z.infer<S> | null {
  const parsed = schema.safeParse(props);
  const last = React.useRef<z.infer<S> | null>(null);
  if (parsed.success) last.current = parsed.data;
  return last.current;
}

// A block draws in a reply and on a page an agent showed, so it reads the
// directory itself instead of the reply's Markdown context.
function Markdown({ source, className }: { source?: string; className?: string }) {
  const directory = useEffectiveDirectory() ?? '';
  if (!source) return null;
  return <MarkdownContent content={source} mode="static" settled directory={directory} className={cn('oc-ui-block-text', className)} />;
}

const isButtonNode = (value: BlockValue) => blockNode.safeParse(value).data?.typeName === 'Button';

// The path of the node whose children are drawing (`blockPath`).
const PathContext = React.createContext<BlockPath>('');
/** Something the block itself adds to the tree, drawn before the child at `index` of the node at `parent`. */
/** `trailing` goes at the end of that child when it is a run of buttons, on their line. */
type Slot = { parent: BlockPath; index: number; element: React.ReactNode; trailing?: React.ReactNode };
const SlotContext = React.createContext<Slot | null>(null);
/** What a Row of buttons draws after its own children (`Slot.trailing`). */
const RowTrailingContext = React.createContext<React.ReactNode>(null);

/**
 * Buttons next to each other share a row, whether or not the agent wrapped
 * them in one. The first `skip` nodes are drawn by the parent elsewhere.
 */
function Children({ nodes, skip = 0 }: { nodes: BlockValue[]; skip?: number }) {
  const path = React.useContext(PathContext);
  const slot = React.useContext(SlotContext);
  const groups: Array<Array<{ node: BlockValue; index: number }>> = [];
  nodes.forEach((node, index) => {
    if (index < skip) return;
    const last = groups.at(-1);
    if (last && isButtonNode(node) && isButtonNode(last[0].node)) last.push({ node, index });
    else groups.push([{ node, index }]);
  });
  const child = ({ node, index }: { node: BlockValue; index: number }) => (
    <PathContext.Provider key={index} value={blockPath(path, index)}><Node value={node} /></PathContext.Provider>
  );
  return (
    <>
      {groups.map((group) => {
        const here = slot && slot.parent === path && slot.index === group[0].index ? slot : null;
        const trailing = here?.trailing;
        const drawn = group.length > 1 || (trailing && isButtonNode(group[0].node))
          ? <div className="flex flex-wrap items-center gap-2">{group.map(child)}{trailing}</div>
          : trailing ? <RowTrailingContext.Provider value={trailing}>{child(group[0])}</RowTrailingContext.Provider> : child(group[0]);
        return (
          <React.Fragment key={group[0].index}>
            {here?.element}
            {drawn}
          </React.Fragment>
        );
      })}
    </>
  );
}

function Stack({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Stack, props);
  return value && <div className="flex flex-col gap-3"><Children nodes={value.children} /></div>;
}

function Row({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Row, props);
  const trailing = React.useContext(RowTrailingContext);
  // Cards, tables and charts share the row's width and its height; badges and
  // buttons keep their own size.
  if (!value) return null;
  // Stats sit in equal columns: in a wrapping flex row the last one alone on
  // its line grew to the full width.
  const stats = value.children.length > 0 && value.children.every((child) => blockNode.safeParse(child).data?.typeName === 'Stat');
  return (
    <div
      className={stats
        ? 'grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 [&>div]:w-full'
        : 'flex flex-wrap items-stretch gap-3 [&>div]:min-w-[12rem] [&>div]:flex-1 [&>button]:self-center [&>span]:self-center'}
    >
      <RowTrailingContext.Provider value={null}><Children nodes={value.children} /></RowTrailingContext.Provider>
      {trailing}
    </div>
  );
}

const isBadgeNode = (value: BlockValue) => blockNode.safeParse(value).data?.typeName === 'Badge';

/** A card's title takes inline Markdown, so an issue or a pull request in it can be a link. */
function CardTitle({ title, className }: { title: string; className?: string }) {
  return <Markdown source={title} className={cn('oc-ui-block-title font-medium', className)} />;
}

/** The title of the card a node sits in; it names the decision of the card's buttons (`decisionOf`). */
const CardTitleContext = React.createContext('');

function Card({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Card, props);
  const form = React.useContext(FormContext);
  const path = React.useContext(PathContext);
  if (!value) return null;
  const card: BlockValue = { type: 'element', typeName: 'Card', props: { title: value.title, children: value.children } };
  const decision = form.folds ? cardDecision(card, form.titles) : null;
  if (decision !== null && form.chosen.has(decision)) return <AnsweredCard title={value.title} decision={decision} />;
  // Badges the card opens with sit on its title line.
  const badges = value.title ? value.children.findIndex((child) => !isBadgeNode(child)) : 0;
  const headerBadges = badges === -1 ? value.children.length : badges;
  const body = <Children nodes={value.children} skip={headerBadges} />;
  return (
    <div className="oc-box flex flex-col gap-2">
      {value.title && (
        <div className="flex items-start gap-2">
          <CardTitle title={value.title} className="min-w-0 flex-1" />
          {headerBadges > 0 && (
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {value.children.slice(0, headerBadges).map((child, index) => (
                <PathContext.Provider key={index} value={blockPath(path, index)}><Node value={child} /></PathContext.Provider>
              ))}
            </span>
          )}
        </div>
      )}
      <InCardContext.Provider value>
        <CardTitleContext.Provider value={value.title}>
          {decision === null ? body : <CardNoteSlot decision={decision} card={card}>{body}</CardNoteSlot>}
        </CardTitleContext.Provider>
      </InCardContext.Provider>
    </div>
  );
}

/**
 * A decision card's note goes before its buttons, so it is written before one
 * of them is pressed; a note alone answers the card too.
 */
function CardNoteSlot({ decision, card, children }: { decision: string; card: BlockValue; children: React.ReactNode }) {
  const { t } = useI18n();
  const form = React.useContext(FormContext);
  const path = React.useContext(PathContext);
  const note = form.notes.get(decision) ?? '';
  const [open, setOpen] = React.useState(note !== '');
  const place = noteSlot(card);
  if (!place || (form.disabled && !note)) return <>{children}</>;
  // The note opens above the buttons; its toggle, then the way to answer
  // with the note alone, sit at the end of their line, so a card is no taller
  // until the user wants a note.
  const element = open ? (
    <ShortTextarea
      value={note}
      placeholder={t('chat.uiBlock.note.placeholder')}
      aria-label={t('chat.uiBlock.note.label')}
      disabled={form.disabled}
      onChange={(event) => form.setNote(decision, event.target.value)}
      // Notes on several cards are a line or two each.
      rows={1}
      autoFocus
    />
  ) : null;
  const trailing = form.disabled ? null : !open ? (
    <UiButton
      type="button"
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:bg-transparent hover:text-foreground"
      aria-label={t('chat.uiBlock.note.add')}
      title={t('chat.uiBlock.note.add')}
      onClick={() => setOpen(true)}
    >
      <Icon name="sticky-note" className="size-4" />
    </UiButton>
  ) : (
    // Shown with the field, so the row does not change once typing starts.
    <UiButton
      type="button"
      variant="ghost"
      className="text-muted-foreground hover:bg-transparent hover:text-foreground"
      disabled={!note.trim()}
      onClick={() => form.answerWithNote(decision)}
    >
      {t('chat.uiBlock.note.answerOnly')}
    </UiButton>
  );
  const slot = { parent: place.parent ? `${path}/${place.parent}` : path, index: place.index, element, trailing };
  return <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>;
}

function NoteToggle({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <UiButton
      type="button"
      variant="ghost"
      size="xs"
      className="w-fit px-0 has-[>svg]:px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      onClick={onOpen}
    >
      <Icon name="add" className="size-3.5" />
      {t('chat.uiBlock.note.add')}
    </UiButton>
  );
}

/** A decision card once answered: one line with the answer, and its note under it. */
function AnsweredCard({ title, decision }: { title: string; decision: string }) {
  const { t } = useI18n();
  const form = React.useContext(FormContext);
  const button = form.chosen.get(decision) ?? null;
  const note = form.notes.get(decision)?.trim() ?? '';
  return (
    <div className="oc-box flex flex-col gap-0.5 py-2">
      <div className="flex items-center gap-2">
        <Icon name="checkbox-circle" className="size-4 shrink-0 text-[var(--status-success)]" />
        <CardTitle title={title} className="min-w-0 flex-1 truncate" />
        <span className="max-w-[50%] shrink-0 truncate typography-ui-label font-medium text-[var(--primary-text)]">
          {button ?? t('chat.uiBlock.note.label')}
        </span>
        {!form.disabled && (
          <UiButton
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => form.reopen(decision)}
          >
            {t('chat.uiBlock.change')}
          </UiButton>
        )}
      </div>
      {note && <div className="line-clamp-2 ps-6 typography-meta text-muted-foreground">{note}</div>}
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
    // The badge HTML pages draw too (../lib/visualKit.ts); a flex column would stretch it without w-fit.
    <span className="oc-badge w-fit" data-tone={value.tone && value.tone !== 'neutral' ? value.tone : undefined}>
      {value.label}
    </span>
  );
}

/**
 * Only a warning or an error is a tinted banner with its title in the tone,
 * as the git and MCP banners are; a note, info or success is an icon and text
 * with no box, so a reply with several of them does not turn into stripes.
 */
function Callout({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Callout, props);
  if (!value) return null;
  const tone = value.tone ?? 'neutral';
  const icon = tone === 'error' || tone === 'warning' ? 'error-warning' : tone === 'success' ? 'checkbox-circle' : 'information';
  const banner = tone === 'error' || tone === 'warning';
  return (
    <div className={cn('flex gap-2', banner ? cn('rounded-xl px-3 py-2', toneFill[tone]) : 'px-1')}>
      <Icon name={icon} className={cn('mt-[3px] size-4 shrink-0', toneText[tone])} />
      <div className="min-w-0 flex-1">
        {value.title && <div className={cn('font-medium', banner && toneText[tone])}>{value.title}</div>}
        <Markdown source={value.markdown} />
      </div>
    </div>
  );
}

/**
 * Labels in one column, values at the end of the other, joined by a dotted
 * leader, as the shortcuts dialog lists keys; narrow, so the eye does not
 * cross a wide reply. A long value wraps within its column: moved to a line
 * of its own, it dangled under the label.
 */
function KeyValue({ props }: NodeProps) {
  const value = useBlockProps(blockProps.KeyValue, props);
  if (!value) return null;
  return (
    <dl className="m-0 grid max-w-lg grid-cols-[fit-content(55%)_minmax(0,1fr)] gap-y-0.5">
      {value.items.map((item, index) => (
        <React.Fragment key={index}>
          <dt className="flex min-w-0 items-baseline gap-3 text-muted-foreground">
            <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
            <span aria-hidden className="min-w-4 flex-1 border-b border-dotted border-border" />
          </dt>
          {/* The leader runs on to a short value at the end; a long one takes the column and wraps there. */}
          <dd className="m-0 flex min-w-0 items-baseline">
            <span aria-hidden className="min-w-0 flex-1 border-b border-dotted border-border" />
            <span className="ps-3 text-end tabular-nums [overflow-wrap:anywhere]">{display(item.value)}</span>
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const tableCell = (cell: string | number | undefined) => (cell === undefined ? '' : number.safeParse(cell).success
  ? display(cell)
  // A pipe splits a GFM cell, also inside code, unless an odd run of
  // backslashes escapes it; backslashes are otherwise the cell's own text.
  : String(cell).replace(/(\\*)\|/g, (match, slashes: string) => (slashes.length % 2 ? match : `${slashes}\\|`)).replace(/\r?\n/g, ' '));

/**
 * The chat's own Markdown table: the same column fitting, copy and download
 * as a table written straight into a reply.
 */
function Table({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Table, props);
  if (!value || value.columns.length === 0) return null;
  const numeric = value.columns.map((_, index) => value.rows.length > 0 && value.rows.every((row) => number.safeParse(row[index]).success));
  const lines = [
    `| ${value.columns.map((column) => tableCell(column)).join(' | ')} |`,
    `| ${numeric.map((isNumeric) => (isNumeric ? '---:' : '---')).join(' | ')} |`,
    ...value.rows.map((row) => `| ${value.columns.map((_, index) => tableCell(row[index])).join(' | ')} |`),
  ];
  return <TableMarkdown source={lines.join('\n')} />;
}

/**
 * In a card the table spans the card and drops its own frame and column
 * lines: the card is the frame, rows keep their dividers. Elsewhere it is the
 * chat's table as written in a reply. The chat's table rules are unlayered,
 * so these overrides need `!`.
 */
const TABLE_IN_CARD = [
  '[&_[data-streamdown=table-wrapper]]:w-full! [&_[data-streamdown=table]]:w-full!',
  '[&_[data-streamdown=table-wrapper]>div]:border-0! [&_[data-streamdown=table-wrapper]>div]:bg-transparent!',
  '[&_[data-streamdown=table-cell]]:border-e-0! [&_[data-streamdown=table-header-cell]]:border-e-0!',
  '[&_tr>*:first-child]:ps-0! [&_tr>*:last-child]:pe-0!',
].join(' ');

function TableMarkdown({ source }: { source: string }) {
  const inCard = React.useContext(InCardContext);
  return <Markdown source={source} className={inCard ? TABLE_IN_CARD : undefined} />;
}

/** A delta's direction from its sign; the agent's tone says whether that is good. */
const deltaDirection = (delta: string) => (/^\+/.test(delta) ? 'up' : /^[-\u2212]/.test(delta) ? 'down' : null);

function Stat({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Stat, props);
  if (!value) return null;
  const direction = value.delta ? deltaDirection(value.delta) : null;
  return (
    // Alone it keeps its own width; in a Row it shares the row (Row's flex-1 wins over w-fit).
    <div className="oc-box flex w-fit min-w-[10rem] flex-col gap-1">
      <span className="typography-meta text-muted-foreground">{value.label}</span>
      <span className="text-[1.625rem] font-semibold leading-tight tracking-[-0.01em] tabular-nums">{display(value.value)}</span>
      {value.delta && (
        // The badge of the shared kit, so a page and a block show a change alike.
        <span className="oc-badge w-fit gap-0.5 tabular-nums" data-tone={value.tone && value.tone !== 'neutral' ? value.tone : undefined}>
          {direction && <Icon name={direction === 'up' ? 'arrow-up' : 'arrow-down'} className="size-3" />}
          {direction ? value.delta.slice(1) : value.delta}
        </span>
      )}
    </div>
  );
}

function Progress({ props }: NodeProps) {
  const { t } = useI18n();
  const value = useBlockProps(blockProps.Progress, props);
  if (!value) return null;
  const max = value.max ?? 100;
  const share = Math.max(0, Math.min(1, value.value / max));
  const done = share >= 1;
  // Never 100% before it is done. Multiplying first keeps 29 of 100 at 29
  // (29 / 100 * 100 is 28.999…).
  const percent = done ? 100 : Math.max(0, Math.min(99, Math.floor((value.value * 100) / max)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">{value.label}</span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
          {/* Out of 100 the count says what the percent already does. */}
          {max !== 100 && (
            <span className="typography-meta text-muted-foreground">
              {t('chat.uiBlock.progress.ofTotal', { value: formatNumber(value.value), max: formatNumber(max) })}
            </span>
          )}
          <span className={cn('flex items-center gap-0.5 font-semibold', done && 'text-[var(--status-success)]')}>
            {done && <Icon name="check" className="size-3.5" />}
            {percent}%
          </span>
        </span>
      </div>
      <div className="oc-track h-2 overflow-hidden rounded-full" role="progressbar" aria-valuenow={value.value} aria-valuemax={max} aria-label={value.label}>
        <div
          className="oc-bar-grow h-full rounded-full"
          style={{ width: `${share * 100}%`, background: done ? 'var(--status-success)' : seriesColor(0) }}
        />
      </div>
    </div>
  );
}

type StepStatus = z.infer<typeof blockProps.Steps>['items'][number]['status'];

/**
 * A step's mark on the line. The current step holds still: an accent disc
 * with a halo, no pulse. A block can stay on screen for a whole session, and a
 * loop that never ends keeps the compositor busy all that time.
 */
function StepMark({ status, index }: { status: StepStatus; index: number }) {
  const base = 'flex size-[1.125rem] shrink-0 items-center justify-center rounded-full';
  if (status === 'done') {
    return <span className={cn(base, 'bg-[var(--status-success)] text-background')}><Icon name="check" className="size-3" /></span>;
  }
  if (status === 'blocked') {
    return <span className={cn(base, 'bg-[var(--status-error)] text-[0.6875rem] font-bold text-background')}>!</span>;
  }
  if (status === 'current') {
    return (
      <span className={cn(base, 'bg-[var(--primary)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_22%,transparent)]')}>
        <span className="size-1.5 rounded-full bg-background" />
      </span>
    );
  }
  return (
    <span className={cn(base, 'typography-micro tabular-nums text-muted-foreground shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--foreground)_22%,transparent)]')}>
      {index + 1}
    </span>
  );
}

const stepTitleTone = {
  done: '',
  current: 'text-[var(--primary-text)]',
  blocked: 'text-[var(--status-error-text)]',
  todo: 'text-muted-foreground',
} satisfies Record<NonNullable<StepStatus>, string>;

/** The line from a step to the next: green once the step is done. */
const stepLine = (status: StepStatus) => (status === 'done' ? 'bg-[var(--status-success)]' : 'bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)]');

/** The minimum width of a step in a row, in rem (`useStepsFitRow`). */
const STEP_MIN_WIDTH_REM = 7;

/** Whether a row of `count` steps fits the width it has, each at its minimum. */
function useStepsFitRow(count: number) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [fits, setFits] = React.useState(true);
  React.useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view || count === 0) return;
    const check = () => {
      const rem = parseFloat(view.getComputedStyle(element.ownerDocument.documentElement).fontSize) || 16;
      setFits(element.clientWidth >= count * STEP_MIN_WIDTH_REM * rem);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  return [ref, fits] as const;
}

function Steps({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Steps, props);
  const [ref, fits] = useStepsFitRow(value?.direction === 'row' ? value.items.length : 0);
  if (!value) return null;
  // A row that does not fit the width falls back to a column: scrolled
  // sideways, the steps past the edge went unseen.
  return <div ref={ref}>{value.direction === 'row' && fits ? <StepsRow items={value.items} /> : <StepsColumn items={value.items} />}</div>;
}

type StepItems = z.infer<typeof blockProps.Steps>['items'];

function StepText({ item }: { item: StepItems[number] }) {
  return (
    <>
      <div className={cn('font-medium', stepTitleTone[item.status ?? 'todo'])}>{item.title}</div>
      <Markdown source={item.markdown} className="typography-meta text-muted-foreground" />
    </>
  );
}

function StepsRow({ items }: { items: StepItems }) {
  // Marks on one line joined left to right, each title under its mark.
  return (
    <div className="grid" role="list" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((item, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-1.5" role="listitem">
          <div className="flex items-center">
            <StepMark status={item.status ?? 'todo'} index={index} />
            {index < items.length - 1 && <span className={cn('mx-1.5 h-0.5 flex-1 rounded-full', stepLine(item.status ?? 'todo'))} />}
          </div>
          <div className="min-w-0 pe-3"><StepText item={item} /></div>
        </div>
      ))}
    </div>
  );
}

function StepsColumn({ items }: { items: StepItems }) {
  // Plain divs: list styles from the surrounding Markdown would take over an ol.
  return (
    <div className="flex flex-col" role="list">
      {items.map((item, index) => (
        <div key={index} className="flex gap-2.5" role="listitem">
          <div className="flex flex-col items-center pt-[3px]">
            <StepMark status={item.status ?? 'todo'} index={index} />
            {index < items.length - 1 && <span className={cn('my-1 min-h-3 w-0.5 flex-1 rounded-full', stepLine(item.status ?? 'todo'))} />}
          </div>
          <div className={cn('min-w-0 flex-1', index < items.length - 1 && 'pb-3')}><StepText item={item} /></div>
        </div>
      ))}
    </div>
  );
}

type Series = z.infer<typeof blockProps.Series>;

/** Series that have arrived whole; a streaming one joins once it parses. */
const seriesOf = (nodes: BlockValue[]): Series[] => nodes.flatMap((node) => {
  const series = blockProps.Series.safeParse(blockNode.safeParse(node).data?.props);
  return series.success ? [series.data] : [];
});

/**
 * Which series a chart brings forward: the one under the pointer, else the one
 * the user picked in the legend (a tap, where there is no hover). null keeps
 * them all equal.
 */
type SeriesFocus = {
  focused: number | null;
  picked: number | null;
  /** The legend: brings a series forward at once, it is pointed at on purpose. */
  hover: (index: number | null) => void;
  /** A line: only once the pointer rests on it, so sweeping across the plot does not flicker. */
  rest: (index: number | null) => void;
  toggle: (index: number) => void;
};

const LINE_FOCUS_DELAY_MS = 200;
const LINE_UNFOCUS_DELAY_MS = 120;

function useSeriesFocus(count: number): SeriesFocus {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [picked, setPicked] = React.useState<number | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => cancel, []);
  // A chart that now has fewer series (another tab, a streamed edit) drops a focus past its end.
  const inRange = (index: number | null) => (index !== null && index < count ? index : null);
  return {
    focused: inRange(hovered) ?? inRange(picked),
    picked: inRange(picked),
    hover: (index) => {
      cancel();
      setHovered(index);
    },
    // Leaving lets go a moment later too: a pointer that slips off a line and
    // back keeps its focus instead of blinking.
    rest: (index) => {
      cancel();
      if (index === hovered) return;
      timer.current = setTimeout(() => setHovered(index), index === null ? LINE_UNFOCUS_DELAY_MS : LINE_FOCUS_DELAY_MS);
    },
    toggle: (index) => setPicked((current) => (current === index ? null : index)),
  };
}

/** Series names when there are several. */
function ChartHeader({ series, focus }: { series: Series[]; focus?: SeriesFocus }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
      {series.length > 1 && series.map((item, index) => {
        const content = (
          <>
            <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(index) }} />
            {item.name}
          </>
        );
        if (!focus) return <span key={index} className="inline-flex items-center gap-1.5">{content}</span>;
        const dimmed = focus.focused !== null && focus.focused !== index;
        return (
          <button
            key={index}
            type="button"
            aria-pressed={focus.picked === index}
            className={cn(
              'inline-flex items-center gap-1.5 transition-[opacity,color] duration-150 hover:text-foreground',
              focus.focused === index && 'text-foreground',
              dimmed && 'opacity-40',
            )}
            onPointerEnter={(event) => { if (event.pointerType === 'mouse') focus.hover(index); }}
            onPointerLeave={(event) => { if (event.pointerType === 'mouse') focus.hover(null); }}
            onClick={() => focus.toggle(index)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

// A card already frames what it holds.
const InCardContext = React.createContext(false);

/** A chart outside a card gets a frame of its own, so two charts in a row never read as one. */
function ChartFrame({ className, ...props }: React.ComponentProps<'div'>) {
  const inCard = React.useContext(InCardContext);
  return <div {...props} className={cn(className, !inCard && 'oc-box')} />;
}

/** The unit by a large figure: after it at text size, so the number stays the thing read first, or a currency sign before it. */
function HeadlineUnit({ unit, leading = false }: { unit?: string; leading?: boolean }) {
  if (!unit || unitLeads(unit) !== leading) return null;
  // A leading currency sign reads as part of the amount, at its size.
  if (leading) return unit;
  return <span className="typography-meta font-normal text-muted-foreground">{unitSuffix(unit)}</span>;
}

/** A share as a whole percent; a sliver that rounds to nothing still shows it is there. */
const formatShare = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

const pointsOf = (series: Series[]) => series.flatMap((item) => item.values.filter((point) => point !== null));

/**
 * What a single series of bars sums up to at a glance: its largest value and
 * the average, or for parts of a whole the total and the largest.
 */
function BarSummary({ points, unit, total }: { points: number[]; unit?: string; total: number | null }) {
  const { t } = useI18n();
  const average = points.reduce((sum, point) => sum + point, 0) / points.length;
  const figure = (label: string, value: number) => (
    <span className="flex flex-col">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums"><HeadlineUnit unit={unit} leading />{formatNumber(value)}<HeadlineUnit unit={unit} /></span>
    </span>
  );
  // Sum and shares only for parts of a whole, which the agent says: a chart of
  // percentages or averages would show false ones.
  if (total !== null) {
    return (
      <div className="flex items-start gap-5">
        {figure(t('chat.uiBlock.chart.total'), total)}
        {figure(t('chat.uiBlock.chart.largest'), Math.max(...points))}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-5">
      {figure(t('chat.uiBlock.chart.largest'), Math.max(...points))}
      {/* Four significant digits: 69.25 and 0.015 stay as they are, a long fraction does not run on. */}
      {figure(t('chat.uiBlock.chart.average'), Math.abs(average) >= 1000 ? Math.round(average) : Number(average.toPrecision(4)))}
    </div>
  );
}

/**
 * A ranked list: each category's name and value on one line, a thin bar under
 * them across the full width, so long names never cut into the bars. One
 * series takes the accent colour, stronger as the value grows, and its largest
 * value in bold; several series each keep their colour.
 */
function BarChart({ props }: NodeProps) {
  const value = useBlockProps(blockProps.BarChart, props);
  if (!value) return null;
  const series = seriesOf(value.series);
  const points = pointsOf(series);
  if (points.length === 0) return null;
  // The scale runs to the round value above the largest bar, the last tick an axis would have.
  const ticks = axisTicks(0, Math.max(0, ...points));
  const scale = ticks[ticks.length - 1] || 1;
  const single = series.length === 1;
  const largest = Math.max(...points);
  const smallest = Math.min(...points);
  const width = (point: number) => `${Math.max(0, Math.min(1, point / scale)) * 100}%`;
  // From a third of the colour at the smallest value to all of it at the largest.
  const strength = (point: number) => (largest === smallest ? 100 : Math.round(30 + (70 * (point - smallest)) / (largest - smallest)));
  // Parts of a whole: each bar is its share of the total, so the track stands
  // for the whole. Negative parts or several series make no whole.
  const sum = points.reduce((total, point) => total + point, 0);
  const total = value.whole && single && smallest >= 0 && sum > 0 ? sum : null;
  const barWidth = (point: number) => (total === null ? width(point) : `${(point / total) * 100}%`);
  return (
    <ChartFrame className="flex flex-col gap-3">
      {single ? <BarSummary points={points} unit={value.unit} total={total} /> : <ChartHeader series={series} />}
      <div className="flex flex-col gap-3">
        {value.labels.map((label, labelIndex) => {
          const values = series.map((item) => item.values[labelIndex] ?? null);
          const top = single && values[0] === largest;
          return (
            <div key={labelIndex} className="group/bar flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 typography-meta">
                <span
                  className={cn('min-w-0 truncate transition-colors duration-150', top ? 'font-semibold text-foreground' : 'text-muted-foreground group-hover/bar:text-foreground')}
                  title={label}
                >
                  {label}
                </span>
                <span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
                  {values.map((point, seriesIndex) => (
                    <span key={seriesIndex} className={cn(top && 'font-semibold')} style={single ? undefined : { color: seriesColor(seriesIndex) }}>
                      {point === null ? '–' : formatWithUnit(point, value.unit)}
                    </span>
                  ))}
                  {total !== null && values[0] !== null && (
                    <span className="min-w-[2.5em] text-end font-normal text-muted-foreground">{formatShare(values[0] / total)}</span>
                  )}
                </span>
              </div>
              {values.map((point, seriesIndex) => (
                <div key={seriesIndex} className="oc-track h-1.5 rounded-full">
                  {point !== null && (
                    <div
                      className="oc-bar-grow h-full rounded-full transition-[filter] duration-150 group-hover/bar:brightness-125"
                      style={{
                        width: barWidth(point),
                        animationDelay: `${Math.min(labelIndex, 12) * 45}ms`,
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
    </ChartFrame>
  );
}

/** Splits a series at its missing points, so the line breaks there instead of dropping to zero. */
const segmentsOf = (values: Array<number | null>): Array<Array<{ index: number; point: number }>> => {
  const segments: Array<Array<{ index: number; point: number }>> = [];
  let current: Array<{ index: number; point: number }> = [];
  values.forEach((point, index) => {
    if (point === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ index, point });
    }
  });
  if (current.length) segments.push(current);
  return segments;
};

// Dots on every point while they stay apart; past this the line alone reads better.
const MAX_DOTTED_POINTS = 12;

const lastPoint = (values: Array<number | null>) => {
  for (let index = values.length - 1; index >= 0; index--) {
    const point = values[index];
    if (point !== null && point !== undefined) return { index, point };
  }
  return null;
};

/**
 * A single trend leads with where it ended and how far it moved: the last
 * value large, then its change from the first point.
 */
function TrendHeader({ series, labels, unit }: { series: Series; labels: string[]; unit?: string }) {
  const { t } = useI18n();
  const values = series.values.slice(0, labels.length);
  const first = values.findIndex((point) => point !== null);
  const last = lastPoint(values);
  if (first < 0 || !last) return null;
  const start = values[first] ?? 0;
  const change = start === 0 || last.index === first ? null : ((last.point - start) / Math.abs(start)) * 100;
  return (
    <div className="flex items-baseline">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums"><HeadlineUnit unit={unit} leading />{formatNumber(last.point)}<HeadlineUnit unit={unit} /></span>
        {change !== null && (
          <span className="typography-meta text-muted-foreground tabular-nums">
            {t('chat.uiBlock.chart.changeSince', { change: `${change > 0 ? '+' : ''}${formatNumber(Math.round(change))}%`, label: labels[first] })}
          </span>
        )}
      </span>
    </div>
  );
}

function LineChart({ props }: NodeProps) {
  const value = useBlockProps(blockProps.LineChart, props);
  const [pointed, setHovered] = React.useState<number | null>(null);
  const focus = useSeriesFocus(value ? seriesOf(value.series).length : 0);
  const gradientId = `oc-area-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!value) return null;
  const { labels } = value;
  // A tap stays until the next one, so a block that now draws fewer labels
  // (a streamed edit, another tab's chart) must not point past its end.
  const hovered = pointed !== null && pointed < labels.length ? pointed : null;
  const series = seriesOf(value.series);
  // One series draws as an area: a trend, read on an axis that spans its own
  // values. Several stay lines on an axis from zero, so they compare.
  const area = series.length === 1;
  const points = pointsOf(series);
  if (points.length === 0) return null;
  const ticks = area ? axisTicks(Math.min(...points), Math.max(...points)) : axisTicks(Math.min(...points, 0), Math.max(...points, 0));
  const end = area ? lastPoint(series[0].values.slice(0, labels.length)) : null;
  const low = ticks[0];
  const span = ticks[ticks.length - 1] - low || 1;
  const width = 600;
  const height = 140;
  // Shares of the plot box: the SVG stretches to it, the HTML overlays use them as percentages.
  const xShare = (index: number) => (labels.length < 2 ? 0.5 : index / (labels.length - 1));
  const yShare = (point: number) => 1 - (point - low) / span;
  // Up to six labels under the plot, spread evenly and always with both ends.
  const step = Math.max(1, Math.ceil((labels.length - 1) / 5));
  const axisLabels = labels.map((label, index) => ({ label, index }))
    .filter(({ index }) => index % step === 0 || index === labels.length - 1);
  const dotted = labels.length <= MAX_DOTTED_POINTS;
  const pointAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || labels.length === 0) return;
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setHovered(labels.length < 2 ? 0 : Math.round(share * (labels.length - 1)));
  };
  const hoveredShare = hovered === null ? 0 : xShare(hovered);
  const dimmedSeries = (index: number) => !area && focus.focused !== null && focus.focused !== index;
  // Several lines have no headline figure, so the top tick carries the unit.
  const tickLabel = (tick: number) => (!area && tick === ticks[ticks.length - 1] ? formatWithUnit(tick, value.unit) : formatNumber(tick));
  // Time runs left to right in every UI language, so the plot and its labels stay LTR.
  return (
    <ChartFrame className="flex flex-col gap-2" dir="ltr">
      {area ? <TrendHeader series={series[0]} labels={labels} unit={value.unit} /> : <ChartHeader series={series} focus={focus} />}
      {/* The top tick's label rises half its height above the plot; the padding keeps it off the header. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 pt-2">
        <div className="relative h-[140px] typography-meta text-muted-foreground tabular-nums">
          {ticks.map((tick) => (
            <span key={tick} className="block whitespace-nowrap text-end leading-none opacity-0" aria-hidden="true">{tickLabel(tick)}</span>
          ))}
          {ticks.map((tick) => (
            <span key={tick} className="absolute end-0 -translate-y-1/2 whitespace-nowrap leading-none" style={{ top: `${yShare(tick) * 100}%` }}>
              {tickLabel(tick)}
            </span>
          ))}
        </div>
        <div
          className="relative h-[140px] touch-pan-y"
          onPointerMove={pointAt}
          onPointerDown={pointAt}
          onPointerLeave={(event) => { if (event.pointerType === 'mouse') setHovered(null); }}
        >
          <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0} x2={width} y1={yShare(tick) * height} y2={yShare(tick) * height}
                stroke="var(--interactive-border)" strokeWidth={1} strokeOpacity={tick === 0 && !area ? 1 : 0.5} vectorEffect="non-scaling-stroke"
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
                {segmentsOf(series[0].values.slice(0, labels.length)).map((segment, segmentIndex) => (
                  <polygon
                    key={segmentIndex}
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
              <line x1={hoveredShare * width} x2={hoveredShare * width} y1={0} y2={height} stroke="var(--muted-foreground)" strokeWidth={1} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />
            )}
            {series.map((item, seriesIndex) => (
              // Brought forward, a series stays; the others step back. The wide
              // clear stroke under each line is what the pointer finds.
              <g
                key={seriesIndex}
                className="transition-opacity duration-150"
                opacity={dimmedSeries(seriesIndex) ? 0.15 : 1}
                onPointerEnter={area ? undefined : (event) => { if (event.pointerType === 'mouse') focus.rest(seriesIndex); }}
                onPointerLeave={area ? undefined : (event) => { if (event.pointerType === 'mouse') focus.rest(null); }}
              >
                {segmentsOf(item.values.slice(0, labels.length)).map((segment, segmentIndex) => {
                  const line = segment.map(({ index, point }) => `${xShare(index) * width},${yShare(point) * height}`).join(' ');
                  return (
                    <React.Fragment key={segmentIndex}>
                      {!area && <polyline fill="none" stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke" points={line} />}
                      <polyline
                        fill="none"
                        stroke={seriesColor(seriesIndex)}
                        strokeWidth={area ? 2.5 : 2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                        points={line}
                      />
                    </React.Fragment>
                  );
                })}
              </g>
            ))}
          </svg>
          {/* Dots are HTML: in the stretched SVG a circle would turn into an ellipse. A
              point with no neighbour draws no line, so it always gets one. */}
          {series.map((item, seriesIndex) => item.values.slice(0, labels.length).map((point, index) => {
            if (point === null) return null;
            const alone = (item.values[index - 1] ?? null) === null && (item.values[index + 1] ?? null) === null;
            const isEnd = end?.index === index;
            if (!dotted && !alone && !isEnd && hovered !== index) return null;
            // On an area the points are hollow and the end is solid, so the eye lands where the trend ended.
            const hollow = area && !isEnd && hovered !== index;
            return (
              <span
                key={`${seriesIndex}-${index}`}
                className={cn(
                  'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
                  hovered === index || isEnd ? 'size-2.5 ring-2 ring-[var(--surface-elevated)]' : hollow ? 'size-2' : 'size-1.5',
                )}
                style={{
                  opacity: dimmedSeries(seriesIndex) ? 0.15 : 1,
                  left: `${xShare(index) * 100}%`,
                  top: `${yShare(point) * 100}%`,
                  background: hollow ? 'var(--surface-elevated)' : seriesColor(seriesIndex),
                  border: hollow ? `1.5px solid ${seriesColor(seriesIndex)}` : undefined,
                }}
              />
            );
          }))}
          {end && hovered === null && (
            <span
              className={cn(
                // Near the top the label goes under its point, inside the plot.
                'pointer-events-none absolute typography-meta font-semibold tabular-nums',
                yShare(end.point) < 0.2 ? 'pt-2' : '-translate-y-full pb-2',
                xShare(end.index) > 0.9 ? '-translate-x-full' : '-translate-x-1/2',
              )}
              style={{ left: `${xShare(end.index) * 100}%`, top: `${yShare(end.point) * 100}%` }}
            >
              {formatWithUnit(end.point, value.unit)}
            </span>
          )}
          {hovered !== null && (
            <div
              className={cn(
                'pointer-events-none absolute top-0 z-10 flex flex-col gap-0.5 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 typography-meta shadow-md',
                hoveredShare > 0.5 ? '-translate-x-full -ms-2' : 'ms-2',
              )}
              // It opens toward the wider side and never past the plot's edge.
              style={{ left: `${hoveredShare * 100}%`, width: 'max-content', maxWidth: `calc(${Math.max(hoveredShare, 1 - hoveredShare) * 100}% - 0.5rem)` }}
            >
              <span className="font-medium">{labels[hovered]}</span>
              {series.map((item, seriesIndex) => {
                const point = item.values[hovered];
                return (
                  <span key={seriesIndex} className={cn('flex items-center gap-1.5', dimmedSeries(seriesIndex) && 'opacity-40')}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(seriesIndex) }} />
                    {series.length > 1 && <span className="min-w-0 truncate text-muted-foreground">{item.name}</span>}
                    <span className="ms-auto ps-2 tabular-nums">
                      {point === null || point === undefined ? '–' : formatWithUnit(point, value.unit)}
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
            return <span key={index} className={cn('absolute top-0 whitespace-nowrap', edge)} style={{ left: `${xShare(index) * 100}%` }}>{label}</span>;
          })}
        </div>
      </div>
    </ChartFrame>
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
      {/* In a tile, so the tab's content does not run into the reply's text after the block. */}
      {/* It frames what it holds as a card does: a chart or table inside takes no frame of its own. */}
      {current && <div className="oc-box flex flex-col gap-3"><InCardContext.Provider value><Children nodes={current.children} /></InCardContext.Provider></div>}
    </div>
  );
}

/**
 * Options as the question tool draws them: one per line with our Radio or
 * Checkbox, so one or several is told by the control. The row itself gets no
 * fill on hover or when chosen; the control and a heavier label show the choice.
 */
function Choice({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Choice, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const current = form.values[value.name];
  const chosen = Array.isArray(current) ? current : current ? [current] : [];
  const toggle = (option: string) => {
    if (form.disabled) return;
    if (!value.multiple) {
      form.setValue(value.name, option);
      return;
    }
    form.setValue(value.name, chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option]);
  };
  return (
    <div className="flex flex-col gap-0.5">
      {value.label && <span className="typography-meta font-medium text-foreground">{value.label}</span>}
      <div className="flex flex-col" role={value.multiple ? 'group' : 'radiogroup'} aria-label={value.label || value.name}>
        {value.options.map((entry) => {
          const { label: option, description } = choiceOption.parse(entry);
          const selected = chosen.includes(option);
          // The control is the focusable part; a click anywhere on the option
          // toggles too, and the control stops its own click from bubbling here.
          return (
            <div
              key={option}
              onClick={() => toggle(option)}
              className={cn('px-1.5 py-1', form.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}
            >
              <div className="flex items-center gap-2">
                {value.multiple
                  ? <Checkbox checked={selected} onChange={() => toggle(option)} disabled={form.disabled} ariaLabel={option} />
                  : <Radio checked={selected} onChange={() => toggle(option)} disabled={form.disabled} ariaLabel={option} />}
                <span className={cn('typography-meta min-w-0', selected ? 'font-medium text-foreground' : 'text-foreground/80')}>{option}</span>
              </div>
              {/* Under the label, as the question tool hangs an option's description. */}
              {description && <div className="typography-micro break-words ps-[22px] text-muted-foreground">{description}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A short text box, as the note on a decision card draws one: the app's own
 * field, a line or two tall. It already takes what the user types as typed
 * and offers emoji on `:`.
 */
function ShortTextarea(props: React.ComponentProps<typeof Textarea>) {
  return <Textarea className="min-h-10" maxLength={4000} {...props} />;
}

function Input({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Input, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const current = form.values[value.name];
  const text = Array.isArray(current) ? current.join(', ') : current ?? '';
  const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => form.setValue(value.name, event.target.value);
  return (
    <label className="flex flex-col gap-1">
      {value.label && <span className="typography-meta font-medium text-foreground">{value.label}</span>}
      {value.multiline
        ? <ShortTextarea rows={2} value={text} placeholder={value.placeholder} disabled={form.disabled} onChange={onChange} />
        : <FieldInput value={text} placeholder={value.placeholder} disabled={form.disabled} onChange={onChange} />}
    </label>
  );
}

/** A date as the scheduled task editor asks for one, with the time beside it when the agent wants it. */
function DateInput({ props }: NodeProps) {
  const value = useBlockProps(blockProps.DateInput, props);
  const form = React.useContext(FormContext);
  const { t } = useI18n();
  const { use24Hour } = useCalendarPreferences();
  const current = value ? form.values[value.name] : undefined;
  const text = Array.isArray(current) ? '' : current ?? '';
  const date = text.slice(0, 10);
  // The time waits here until a date is picked, then travels with it.
  const [pendingTime, setPendingTime] = React.useState(DEFAULT_TIME);
  if (!value) return null;
  const time = text.slice(11, 16) || pendingTime;
  const set = (nextDate: string, nextTime: string) => {
    if (!form.disabled) form.setValue(value.name, value.time ? `${nextDate}T${nextTime}` : nextDate);
  };
  return (
    <div className="flex flex-col gap-1">
      {value.label && <span className="typography-meta font-medium text-foreground">{value.label}</span>}
      {/* A fieldset disables the time's own inputs and menu with the form. */}
      <fieldset disabled={form.disabled} className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
        <DatePicker
          value={date}
          onChange={(nextDate) => set(nextDate, time)}
          placeholder={t('sessions.scheduledTasks.editor.date.placeholder')}
          ariaLabel={value.label || value.name}
          disabled={form.disabled}
        />
        {value.time && (
          <TimePill
            value={time}
            use24Hour={use24Hour}
            hourAriaLabel={t('sessions.scheduledTasks.editor.time.hourAria')}
            minuteAriaLabel={t('sessions.scheduledTasks.editor.time.minuteAria')}
            periodAriaLabel={t('sessions.scheduledTasks.editor.time.periodAria')}
            amLabel={t('sessions.scheduledTasks.editor.time.period.am')}
            pmLabel={t('sessions.scheduledTasks.editor.time.period.pm')}
            onChange={(nextTime) => {
              setPendingTime(nextTime);
              if (date) set(date, nextTime);
            }}
          />
        )}
      </fieldset>
    </div>
  );
}

/** The voice settings' slider, with the value it stands at beside the label and the range under the track. */
const SLIDER_CLASS = 'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--interactive-border)] disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--primary-base)]';

function Slider({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Slider, props);
  const form = React.useContext(FormContext);
  if (!value) return null;
  const stored = Number(form.values[value.name]);
  const position = Number.isFinite(stored) ? stored : sliderStart(value);
  return (
    <label className="flex max-w-md flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 typography-meta">
        <span className="font-medium text-foreground">{value.label || value.name}</span>
        <span className="font-semibold tabular-nums text-foreground">{formatWithUnit(position, value.unit)}</span>
      </span>
      <input
        type="range"
        min={value.min}
        max={value.max}
        step={value.step ?? 1}
        value={position}
        disabled={form.disabled}
        onChange={(event) => form.setValue(value.name, event.target.value)}
        className={SLIDER_CLASS}
      />
      <span className="flex justify-between typography-micro tabular-nums text-muted-foreground">
        <span>{formatWithUnit(value.min, value.unit)}</span>
        <span>{formatWithUnit(value.max, value.unit)}</span>
      </span>
    </label>
  );
}

/** A section folded under its title, as Markdown folds `<details>`: a chevron that turns, the content under it. */
function Details({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Details, props);
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  if (!value) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit items-center gap-1 text-start font-medium text-foreground/80 transition-colors hover:text-foreground"
      >
        <Icon name="arrow-right-s" className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90 rtl:-rotate-90')} />
        <Markdown source={value.title} className="oc-ui-block-title" />
      </button>
      {/* Kept mounted while closed, so a field inside keeps what the user typed. */}
      <div id={panelId} hidden={!open} className="flex flex-col gap-3 ps-5">
        <Children nodes={value.children} />
      </div>
    </div>
  );
}

function Button({ props }: NodeProps) {
  const value = useBlockProps(blockProps.Button, props);
  const form = React.useContext(FormContext);
  const cardTitle = React.useContext(CardTitleContext);
  if (!value) return null;
  // A page answers at once, so there its buttons are told apart by value alone.
  const decision = form.folds ? decisionOf(form.titles, cardTitle, value.value) : value.value ?? '';
  const chosen = form.chosen.get(decision) === value.label;
  // A primary button is the agent's pick and stays tinted until the decision
  // has an answer; then only the chosen one is, with a check.
  const recommended = value.variant === 'primary' && !form.chosen.has(decision);
  return (
    <UiButton
      type="button"
      variant={chosen || recommended ? 'default' : 'outline'}
      className="w-fit"
      aria-pressed={chosen}
      disabled={form.disabled}
      onClick={() => form.press(value.label, form.folds ? decision : value.value)}
    >
      {chosen && <Icon name="check" className="size-3.5" />}
      {value.label}
    </UiButton>
  );
}

// Tab and Series draw inside their parents.
const renderers = {
  Stack, Row, Card, Tabs, Details, Text, Badge, Callout, KeyValue, Table, Stat, Progress, Steps, BarChart, LineChart, Choice, Input,
  DateInput, Slider, Button,
} satisfies Partial<Record<BlockName, React.FC<NodeProps>>>;
const drawn = blockName.extract([
  'Stack', 'Row', 'Card', 'Tabs', 'Details', 'Text', 'Badge', 'Callout', 'KeyValue', 'Table', 'Stat', 'Progress', 'Steps', 'BarChart',
  'LineChart', 'Choice', 'Input', 'DateInput', 'Slider', 'Button',
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

/** The kit's CSS (badges, boxes, bars) that HTML pages carry in their own document, added to the app's once. */
function addKitStyles() {
  if (document.querySelector('style[data-oc-visual-kit]')) return;
  const style = document.createElement('style');
  style.dataset.ocVisualKit = '';
  style.textContent = KIT_SHARED_CSS;
  document.head.append(style);
}

export function UiBlock({ source, complete, host = noHost, onNotDrawn }: {
  source: string;
  complete: boolean;
  host?: UiBlockHost;
  /** Hears why a finished block could not be drawn: the parser's errors, or a drawing failure. */
  onNotDrawn?: (errors: string[]) => void;
}) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const parsed = React.useMemo(() => parseUiBlock(source, complete), [source, complete]);
  // The kit's variables (series colours, tones) land on the block's root before paint, and follow a theme switch.
  const blockRef = React.useRef<HTMLDivElement>(null);
  React.useInsertionEffect(addKitStyles, []);
  React.useLayoutEffect(() => {
    const element = blockRef.current;
    if (!element) return;
    for (const [name, color] of Object.entries(kitVariables(currentTheme))) element.style.setProperty(name, color);
  }, [currentTheme, parsed.kind]);
  const notDrawnErrors = parsed.kind === 'invalid' ? parsed.errors : null;
  React.useEffect(() => {
    if (notDrawnErrors) onNotDrawn?.(notDrawnErrors);
  }, [notDrawnErrors, onNotDrawn]);
  const [values, setValues] = React.useState<Record<string, UiBlockFieldValue>>(() => host.answered?.values ?? {});
  const [chosen, setChosen] = React.useState<Chosen>(() => chosenFrom(host));
  const [notes, setNotes] = React.useState<Notes>(() => notesFrom(host));
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(host.answered !== null);
  const [failed, setFailed] = React.useState(false);
  const pageNote = (answer: UiBlockHost['answered']) => (answer && 'note' in answer ? answer.note ?? '' : '');
  const [note, setNote] = React.useState(() => pageNote(host.answered));
  const [noteOpen, setNoteOpen] = React.useState(() => pageNote(host.answered) !== '');
  // An answer stored after this block mounted (given on another device, or
  // read back after a reload) shows here too and freezes the block.
  const [shownAnswer, setShownAnswer] = React.useState(host.answered);
  if (host.answered !== shownAnswer) {
    setShownAnswer(host.answered);
    if (host.answered) {
      setValues(host.answered.values);
      setChosen(chosenFrom(host));
      setNotes(notesFrom(host));
      setNote(pageNote(host.answered));
      setNoteOpen(pageNote(host.answered) !== '');
      setSent(true);
    }
  }
  const root = parsed.kind === 'ready' ? parsed.root : null;
  const fields = React.useMemo(() => (root && complete ? blockFields(root) : []), [root, complete]);
  const decisions = React.useMemo(() => (root ? blockDecisions(root) : []), [root]);
  const titles = React.useMemo(() => (root ? decisionTitles(root) : new Set<string>()), [root]);
  // A field the agent prefilled (a date, a slider's start) answers with that until the user changes it.
  const answerValues = React.useMemo<Record<string, UiBlockFieldValue>>(() => ({
    ...Object.fromEntries(fields.flatMap((field) => (field.initial === undefined ? [] : [[field.name, field.initial]]))),
    ...values,
  }), [fields, values]);
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
      picks: [],
      values: answerValues,
      skipped: [],
    };
    // A note written on a card answers it even when no button was pressed.
    for (const decision of decisions) {
      const pick: UiBlockReplyAnswerData['picks'][number] = {};
      const button = choices.get(decision);
      const decisionNote = notes.get(decision)?.trim();
      if (button) pick.button = button;
      if (decision) pick.value = decision;
      if (decisionNote) pick.note = decisionNote;
      if (pick.button || pick.note) answer.picks.push(pick);
      else answer.skipped.push(decision);
    }
    deliver(() => submit(answer, describeUiBlockReplyAnswer(fields, answer)));
  }, [host, decisions, answerValues, notes, fields, deliver]);

  const form = React.useMemo<FormState>(() => ({
    values: answerValues,
    disabled,
    chosen,
    folds: host.kind === 'reply',
    titles,
    notes,
    setValue: (name, value) => setValues((previous) => ({ ...previous, [name]: value })),
    setNote: (decision, text) => setNotes((previous) => new Map(previous).set(decision, text)),
    answerWithNote: (decision) => {
      if (disabled) return;
      const next = new Map(chosen).set(decision, null);
      setChosen(next);
      if (decisions.every((item) => next.has(item))) sendReply(next);
    },
    reopen: (decision) => {
      if (disabled) return;
      const next = new Map(chosen);
      next.delete(decision);
      setChosen(next);
    },
    press: (button, value) => {
      if (disabled) return;
      const decision = value ?? '';
      if (host.kind === 'page') {
        if (!host.submit) return;
        const { submit } = host;
        const trimmedNote = note.trim();
        const data: UiBlockAnswerData = { button, values: answerValues };
        if (value) data.value = value;
        if (trimmedNote) data.note = trimmedNote;
        setChosen(new Map([[decision, button]]));
        deliver(() => submit({ summary: describeUiBlockAnswer(fields, data, t('chat.uiBlock.note.label')), data }));
        return;
      }
      // A press chooses; pressing the chosen button again clears the choice.
      const next = new Map(chosen);
      if (next.get(decision) === button) next.delete(decision);
      else next.set(decision, button);
      setChosen(next);
      if (decisions.every((item) => next.has(item))) sendReply(next);
    },
  }), [answerValues, disabled, chosen, titles, notes, host, fields, decisions, deliver, sendReply, note, t]);
  // Sending what is chosen so far, or again after a failed send.
  // Every waiting form lets the user qualify their answer, whether or not the
  // agent thought to ask: "this option, and also ...". It sits before the
  // form's last buttons, so it is written before one of them is pressed.
  const showNote = host.kind === 'page' && Boolean(host.submit || note);
  const slotPlace = React.useMemo(() => (root && showNote ? noteSlot(root) : null), [root, showNote]);
  // The form's own fields are compact, so its note is too.
  const noteElement = !showNote ? null : noteOpen ? (
    <ShortTextarea
      value={note}
      placeholder={t('chat.uiBlock.note.placeholder')}
      aria-label={t('chat.uiBlock.note.label')}
      disabled={disabled}
      onChange={(event) => setNote(event.target.value)}
      rows={2}
      autoFocus={!sent}
      maxLength={4000}
    />
  ) : !disabled ? <NoteToggle onOpen={() => setNoteOpen(true)} /> : null;
  const slot = slotPlace && noteElement ? { ...slotPlace, element: noteElement } : null;
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
    <div ref={blockRef} data-oc-ui-block="" className="oc-ui-block my-3">
      <BlockErrorBoundary source={source} fallback={fallback} onFailed={onNotDrawn}>
        <FormContext.Provider value={form}>
          <SlotContext.Provider value={slot}>
            <Node value={parsed.root} />
          </SlotContext.Provider>
        </FormContext.Provider>
      </BlockErrorBoundary>
      {showNote && !slot && noteElement ? <div className="mt-2">{noteElement}</div> : null}
      {/* A block that sends keeps one line for what happened, so the reply does not jump. */}
      {decisions.length > 0 && host.kind === 'reply' && (host.submit || sent) ? (
        <div className="mt-1 flex min-h-6 items-center gap-2 typography-meta text-muted-foreground" aria-live="polite" data-export-ignore>
          {failed ? <span className="text-[var(--status-error)]">{t('chat.uiBlock.sendFailed')}</span>
            : sent ? <span>{t('chat.uiBlock.sent')}</span>
              : chosen.size > 0 && decisions.length > 1
                ? <span>{t('chat.uiBlock.chosenCount', { count: chosen.size, total: decisions.length })}</span>
                : null}
          {canSendChosen ? (
            <UiButton type="button" variant="ghost" size="xs" className="text-foreground/80 hover:bg-transparent hover:text-foreground" disabled={disabled} onClick={() => sendReply(chosen)}>
              {t('chat.uiBlock.sendChosen')}
            </UiButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
