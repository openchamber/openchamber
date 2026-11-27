import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Button as UiButton } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Input as FieldInput } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { DatePicker, TimePill } from '@/components/ui/date-time';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useCalendarPreferences } from '@/components/ui/useCalendarPreferences';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { KIT_SHARED_CSS, kitVariables, seriesColor } from '../lib/visualKit';
import { MarkdownContent } from '../MarkdownRenderer';
import { MarkdownPresentationContext } from '../markdown/MarkdownPresentationContext';
import { useBlockDelivery } from '../uiBlocks/useBlockDelivery';
import { A2uiBarChart, A2uiLineChart, type A2uiChartSeries } from './A2uiCharts';
import { A2uiCognitiveMap } from './A2uiCognitiveMap';
import { A2uiQuestionBatch } from './A2uiQuestionBatch';
import {
  describeA2uiReplyAnswer,
  type A2uiAnswerData,
  type A2uiPageSubmission,
  type A2uiReplyDraft,
} from './answer';
import {
  extractBoundPath,
  formatA2uiSummary,
  getByPointer,
  isPlainObject,
  joinPointer,
  normalizeQuestionBatchItems,
  parseA2uiMessages,
  resolveActionContext,
  resolveBoolean,
  resolveDynamicValue,
  resolveString,
  setByPointer,
  type A2uiComponent,
  type A2uiJson,
  type A2uiObject,
  type A2uiSurfaceState,
} from './protocol';

export type A2uiHost =
  | { kind: 'page'; submit: ((submission: A2uiPageSubmission) => Promise<void>) | null; answered: A2uiAnswerData | null }
  | { kind: 'reply'; submit: ((answer: A2uiAnswerData, text: string) => Promise<void>) | null; answered: A2uiAnswerData | null }
  | { kind: 'demo'; submit: ((answer: A2uiAnswerData, summary: string) => Promise<void>) | null; answered: A2uiAnswerData | null };

export interface A2uiDraftStorage {
  load: () => A2uiReplyDraft | undefined;
  save: (draft: A2uiReplyDraft | null) => void;
}

const NO_HOST: A2uiHost = { kind: 'reply', submit: null, answered: null };

interface SurfaceContextValue {
  surface: A2uiSurfaceState;
  dataModel: A2uiJson;
  disabled: boolean;
  isDemo: boolean;
  setPath: (path: string, value: A2uiJson, scope?: string) => void;
  dispatchAction: (actionName: string, context: A2uiObject) => void;
  openModalId: string | null;
  setOpenModalId: (id: string | null) => void;
  renderMarkdown: (source: string, className?: string) => React.ReactNode;
}

const SurfaceContext = React.createContext<SurfaceContextValue | null>(null);
const ScopeContext = React.createContext<string>('');
const InCardContext = React.createContext<boolean>(false);

function addKitStyles() {
  if (typeof document === 'undefined' || document.querySelector('style[data-oc-visual-kit]')) return;
  const style = document.createElement('style');
  style.dataset.ocVisualKit = '';
  style.textContent = KIT_SHARED_CSS;
  document.head.append(style);
}

const toneText: Record<string, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-[var(--status-info)]',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
};

const toneFill: Record<string, string> = {
  neutral: 'oc-tile',
  info: 'bg-[var(--status-info-background)]',
  success: 'bg-[var(--status-success-background)]',
  warning: 'bg-[var(--status-warning-background)]',
  error: 'bg-[var(--status-error-background)]',
};

const SLIDER_CLASS =
  'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--interactive-border)] disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--primary-base)]';

function parseSeries(raw: A2uiJson | undefined): A2uiChartSeries[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.values)) return [];
    const values = entry.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    return [{ name: entry.name, values }];
  });
}

function ChildList({ childrenProp }: { childrenProp: A2uiJson | undefined }) {
  const ctx = React.useContext(SurfaceContext);
  const scope = React.useContext(ScopeContext);
  if (!ctx || !childrenProp) return null;

  // Static list of component IDs: ["header", "body"]
  if (Array.isArray(childrenProp)) {
    return (
      <>
        {childrenProp.map((id, idx) =>
          typeof id === 'string' ? <A2uiNode key={`${id}-${idx}`} componentId={id} /> : null,
        )}
      </>
    );
  }

  // A2UI v0.9 template binding: { componentId: "item-card", path: "/items" }
  if (isPlainObject(childrenProp)) {
    const templateId =
      typeof childrenProp.componentId === 'string'
        ? childrenProp.componentId
        : typeof childrenProp.template === 'string'
          ? childrenProp.template
          : null;
    const dataPath =
      typeof childrenProp.path === 'string'
        ? childrenProp.path
        : typeof childrenProp.dataBinding === 'string'
          ? childrenProp.dataBinding
          : null;
    if (templateId && dataPath) {
      const collection = getByPointer(ctx.dataModel, dataPath, scope);
      if (Array.isArray(collection)) {
        return (
          <>
            {collection.map((_, index) => {
              const itemScope = joinPointer(dataPath.startsWith('/') ? dataPath : joinPointer(scope, dataPath), index);
              return (
                <ScopeContext.Provider key={itemScope} value={itemScope}>
                  <A2uiNode componentId={templateId} />
                </ScopeContext.Provider>
              );
            })}
          </>
        );
      }
      if (isPlainObject(collection)) {
        return (
          <>
            {Object.keys(collection).map((key) => {
              const itemScope = joinPointer(dataPath.startsWith('/') ? dataPath : joinPointer(scope, dataPath), key);
              return (
                <ScopeContext.Provider key={itemScope} value={itemScope}>
                  <A2uiNode componentId={templateId} />
                </ScopeContext.Provider>
              );
            })}
          </>
        );
      }
    }
  }
  return null;
}

function A2uiTabs({ component }: { component: A2uiComponent }) {
  const ctx = React.useContext(SurfaceContext)!;
  const scope = React.useContext(ScopeContext);
  const [active, setActive] = React.useState('0');
  const rawTabs = Array.isArray(component.tabs) ? component.tabs : Array.isArray(component.tabItems) ? component.tabItems : [];
  const tabs = rawTabs.flatMap((entry) => {
    if (!isPlainObject(entry)) return [];
    const label = resolveString(entry.title ?? entry.label, ctx.dataModel, scope);
    const child = typeof entry.child === 'string' ? entry.child : null;
    const children = Array.isArray(entry.children) ? entry.children : null;
    if (!label || (!child && !children)) return [];
    return [{ label, child, children }];
  });
  if (tabs.length === 0) return null;
  const activeIndex = Number(active) < tabs.length ? Number(active) : 0;
  const current = tabs[activeIndex];
  return (
    <div className="flex flex-col gap-2">
      <SortableTabsStrip
        items={tabs.map((tab, index) => ({ id: String(index), label: tab.label }))}
        activeId={String(activeIndex)}
        onSelect={setActive}
        variant="active-pill"
        layoutMode="scrollable"
        intrinsicWidth
        pillSize="toolbar"
        className="h-7 max-w-full flex-none self-start"
      />
      {current && (
        <div className="oc-box flex flex-col gap-3">
          <InCardContext.Provider value>
            {current.child ? <A2uiNode componentId={current.child} /> : <ChildList childrenProp={current.children ?? undefined} />}
          </InCardContext.Provider>
        </div>
      )}
    </div>
  );
}

function A2uiDetails({ component }: { component: A2uiComponent }) {
  const ctx = React.useContext(SurfaceContext)!;
  const scope = React.useContext(ScopeContext);
  const [open, setOpen] = React.useState(Boolean(component.defaultOpen));
  const title = resolveString(component.title ?? component.label, ctx.dataModel, scope);
  const childId = typeof component.child === 'string' ? component.child : null;
  const panelId = React.useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-fit items-center gap-1 text-start typography-meta font-medium text-foreground/80 transition-colors hover:text-foreground"
      >
        <Icon name="arrow-right-s" className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />
        <span>{title || 'Details'}</span>
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col gap-2.5 ps-5">
        {childId ? <A2uiNode componentId={childId} /> : <ChildList childrenProp={component.children} />}
      </div>
    </div>
  );
}

function A2uiChoicePicker({ component }: { component: A2uiComponent }) {
  const ctx = React.useContext(SurfaceContext)!;
  const scope = React.useContext(ScopeContext);
  const [expandedOpt, setExpandedOpt] = React.useState<ReadonlySet<string>>(() => new Set());
  const label = resolveString(component.label, ctx.dataModel, scope);
  const variant = resolveString(component.variant, ctx.dataModel, scope);
  const multiple = variant === 'multipleSelection' || component.multiple === true;

  const rawOptions = resolveDynamicValue(component.options, ctx.dataModel, scope);
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((entry) => {
        if (typeof entry === 'string') return [{ label: entry, value: entry, description: undefined, detail: undefined }];
        if (!isPlainObject(entry)) return [];
        const optLabel = resolveString(entry.label, ctx.dataModel, scope);
        const optValue = typeof entry.value === 'string' ? entry.value : optLabel;
        if (!optLabel) return [];
        return [{
          label: optLabel,
          value: optValue,
          description: entry.description ? resolveString(entry.description, ctx.dataModel, scope) : undefined,
          detail: entry.detail ? resolveString(entry.detail, ctx.dataModel, scope) : undefined,
        }];
      })
    : [];

  const boundPath = extractBoundPath(component.value) ?? `/fields/${component.id}`;
  const current = getByPointer(ctx.dataModel, boundPath, scope);
  const selectedList = Array.isArray(current)
    ? current.filter((v): v is string => typeof v === 'string')
    : typeof current === 'string' && current
      ? [current]
      : [];

  const toggleOption = (val: string) => {
    if (ctx.disabled) return;
    if (!multiple) {
      // Write scalar when initial value is not an array, otherwise 1-element array per A2UI ChoicePicker spec.
      const next: A2uiJson = Array.isArray(current) ? [val] : val;
      ctx.setPath(boundPath, next, scope);
      return;
    }
    const next = selectedList.includes(val)
      ? selectedList.filter((item) => item !== val)
      : [...selectedList, val];
    ctx.setPath(boundPath, next, scope);
  };

  return (
    <div className="flex flex-col gap-1">
      {label && <span className="typography-meta font-medium text-foreground">{label}</span>}
      <div className="flex flex-col gap-0.5" role={multiple ? 'group' : 'radiogroup'} aria-label={label || component.id}>
        {options.map((opt) => {
          const selected = selectedList.includes(opt.value);
          const detailOpen = expandedOpt.has(opt.value);
          return (
            <div key={opt.value} className="flex flex-col">
              <div className="flex items-start gap-1">
                <div
                  onClick={() => toggleOption(opt.value)}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors',
                    ctx.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    selected && 'bg-[var(--primary)]/10',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {multiple ? (
                      <Checkbox checked={selected} onChange={() => toggleOption(opt.value)} disabled={ctx.disabled} ariaLabel={opt.label} />
                    ) : (
                      <Radio checked={selected} onChange={() => toggleOption(opt.value)} disabled={ctx.disabled} ariaLabel={opt.label} />
                    )}
                    <span className={cn('typography-meta min-w-0', selected ? 'font-medium text-foreground' : 'text-foreground/85')}>
                      {opt.label}
                    </span>
                  </div>
                  {opt.description && (
                    <div className="ps-6 pt-0.5 typography-micro text-muted-foreground">{opt.description}</div>
                  )}
                </div>
                {opt.detail && (
                  <button
                    type="button"
                    aria-expanded={detailOpen}
                    onClick={() =>
                      setExpandedOpt((prev) => {
                        const next = new Set(prev);
                        if (next.has(opt.value)) next.delete(opt.value);
                        else next.add(opt.value);
                        return next;
                      })
                    }
                    className="mt-1.5 shrink-0 rounded px-1.5 py-0.5 typography-micro text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  >
                    {detailOpen ? 'Less' : 'Details'}
                  </button>
                )}
              </div>
              {opt.detail && detailOpen && (
                <div className="ms-8 mb-1 rounded-md bg-foreground/5 px-2.5 py-1.5 typography-micro text-muted-foreground">
                  {ctx.renderMarkdown(opt.detail)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function A2uiDateTimeInput({ component }: { component: A2uiComponent }) {
  const ctx = React.useContext(SurfaceContext)!;
  const scope = React.useContext(ScopeContext);
  const { t } = useI18n();
  const { use24Hour } = useCalendarPreferences();
  const label = resolveString(component.label, ctx.dataModel, scope);
  const enableTime = component.enableTime === true;
  const boundPath = extractBoundPath(component.value) ?? `/fields/${component.id}`;
  const current = getByPointer(ctx.dataModel, boundPath, scope);
  const text = typeof current === 'string' ? current : '';
  const date = text.slice(0, 10);
  const [pendingTime, setPendingTime] = React.useState('09:00');
  const time = text.slice(11, 16) || pendingTime;

  const set = (nextDate: string, nextTime: string) => {
    if (ctx.disabled) return;
    ctx.setPath(boundPath, enableTime ? `${nextDate}T${nextTime}` : nextDate, scope);
  };

  return (
    <div className="flex flex-col gap-1">
      {label && <span className="typography-meta font-medium text-foreground">{label}</span>}
      <fieldset disabled={ctx.disabled} className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
        <DatePicker
          value={date}
          onChange={(nextDate) => set(nextDate, time)}
          placeholder={t('sessions.scheduledTasks.editor.date.placeholder')}
          ariaLabel={label || component.id}
          disabled={ctx.disabled}
        />
        {enableTime && (
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

function A2uiNode({ componentId }: { componentId: string }) {
  const ctx = React.useContext(SurfaceContext);
  const scope = React.useContext(ScopeContext);
  const inCard = React.useContext(InCardContext);
  if (!ctx) return null;

  const component = ctx.surface.components.get(componentId);
  if (!component) return null;

  // Reactive conditional visibility: visible / visibleWhen
  if (component.visible !== undefined && !resolveBoolean(component.visible, ctx.dataModel, scope, true)) {
    return null;
  }
  if (component.visibleWhen !== undefined && !resolveBoolean(component.visibleWhen, ctx.dataModel, scope, true)) {
    return null;
  }

  switch (component.component) {
    case 'Column':
      return (
        <div className="flex flex-col gap-3">
          <ChildList childrenProp={component.children} />
        </div>
      );

    case 'Row': {
      const childIds = Array.isArray(component.children) ? component.children : [];
      const allStats =
        childIds.length > 0 &&
        childIds.every((id) => typeof id === 'string' && ctx.surface.components.get(id)?.component === 'Stat');
      return (
        <div
          className={
            allStats
              ? 'grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 [&>div]:w-full'
              : 'flex flex-wrap items-center gap-2.5'
          }
        >
          <ChildList childrenProp={component.children} />
        </div>
      );
    }

    case 'Card': {
      const title = resolveString(component.title, ctx.dataModel, scope);
      const childId = typeof component.child === 'string' ? component.child : null;
      return (
        <div className="oc-box flex flex-col gap-2">
          {title && <div className="font-medium text-foreground">{ctx.renderMarkdown(title, 'oc-ui-block-title')}</div>}
          <InCardContext.Provider value>
            {childId ? <A2uiNode componentId={childId} /> : <ChildList childrenProp={component.children} />}
          </InCardContext.Provider>
        </div>
      );
    }

    case 'List': {
      const horizontal = resolveString(component.direction, ctx.dataModel, scope) === 'horizontal';
      return (
        <div className={horizontal ? 'flex flex-wrap gap-3' : 'flex flex-col gap-2.5'}>
          <ChildList childrenProp={component.children} />
        </div>
      );
    }

    case 'Tabs':
      return <A2uiTabs component={component} />;

    case 'Details':
      return <A2uiDetails component={component} />;

    case 'Modal': {
      const entryId = typeof component.entryPointChild === 'string' ? component.entryPointChild : null;
      const contentId = typeof component.contentChild === 'string' ? component.contentChild : null;
      const modalTitle = resolveString(component.title, ctx.dataModel, scope) || 'Details';
      const isOpen = ctx.openModalId === component.id;
      return (
        <>
          {entryId ? (
            <span onClick={() => ctx.setOpenModalId(component.id)} className="inline-flex cursor-pointer">
              <A2uiNode componentId={entryId} />
            </span>
          ) : null}
          <Dialog open={isOpen} onOpenChange={(next) => ctx.setOpenModalId(next ? component.id : null)}>
            <DialogContent className="max-w-xl bg-background">
              <DialogTitle>{modalTitle}</DialogTitle>
              <div className="flex flex-col gap-3 pt-2">
                {contentId ? <A2uiNode componentId={contentId} /> : <ChildList childrenProp={component.children} />}
              </div>
            </DialogContent>
          </Dialog>
        </>
      );
    }

    case 'Divider':
      return <hr className="my-1 border-0 border-t border-border" />;

    case 'Text': {
      const text = resolveString(component.text ?? component.markdown, ctx.dataModel, scope);
      if (!text) return null;
      const variant = resolveString(component.variant, ctx.dataModel, scope);
      const cls =
        variant === 'h1'
          ? 'text-lg font-semibold text-foreground'
          : variant === 'h2'
            ? 'text-base font-semibold text-foreground'
            : variant === 'h3' || variant === 'h4'
              ? 'typography-meta font-semibold text-foreground'
              : variant === 'caption'
                ? 'typography-micro text-muted-foreground'
                : undefined;
      return <div className={cls}>{ctx.renderMarkdown(text)}</div>;
    }

    case 'Badge': {
      const label = resolveString(component.label ?? component.text, ctx.dataModel, scope);
      if (!label) return null;
      const tone = resolveString(component.tone, ctx.dataModel, scope);
      return (
        <span className="oc-badge w-fit" data-tone={tone && tone !== 'neutral' ? tone : undefined}>
          {label}
        </span>
      );
    }

    case 'Callout': {
      const text = resolveString(component.text ?? component.markdown, ctx.dataModel, scope);
      const title = resolveString(component.title, ctx.dataModel, scope);
      const tone = resolveString(component.tone, ctx.dataModel, scope) || 'neutral';
      const icon = tone === 'error' || tone === 'warning' ? 'error-warning' : tone === 'success' ? 'checkbox-circle' : 'information';
      const banner = tone === 'error' || tone === 'warning';
      return (
        <div className={cn('flex gap-2', banner ? cn('rounded-xl px-3 py-2', toneFill[tone]) : 'px-1')}>
          <Icon name={icon} className={cn('mt-[3px] size-4 shrink-0', toneText[tone] ?? toneText.neutral)} />
          <div className="min-w-0 flex-1">
            {title && <div className={cn('font-medium', banner && (toneText[tone] ?? ''))}>{title}</div>}
            {text && ctx.renderMarkdown(text)}
          </div>
        </div>
      );
    }

    case 'KeyValue': {
      const rawItems = resolveDynamicValue(component.items, ctx.dataModel, scope);
      if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
      return (
        <dl className="m-0 grid max-w-lg grid-cols-[fit-content(55%)_minmax(0,1fr)] gap-y-0.5">
          {rawItems.map((entry, idx) => {
            if (!isPlainObject(entry)) return null;
            const k = resolveString(entry.label, ctx.dataModel, scope);
            const v = resolveString(entry.value, ctx.dataModel, scope);
            return (
              <React.Fragment key={idx}>
                <dt className="flex min-w-0 items-baseline gap-3 text-muted-foreground">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{k}</span>
                  <span aria-hidden className="min-w-4 flex-1 border-b border-dotted border-border" />
                </dt>
                <dd className="m-0 flex min-w-0 items-baseline">
                  <span aria-hidden className="min-w-0 flex-1 border-b border-dotted border-border" />
                  <span className="ps-3 text-end tabular-nums [overflow-wrap:anywhere]">{v}</span>
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      );
    }

    case 'Table': {
      const cols = resolveDynamicValue(component.columns, ctx.dataModel, scope);
      const rows = resolveDynamicValue(component.rows, ctx.dataModel, scope);
      if (!Array.isArray(cols) || cols.length === 0 || !Array.isArray(rows)) return null;
      const esc = (cell: A2uiJson | undefined) => String(cell ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
      const lines = [
        `| ${cols.map(esc).join(' | ')} |`,
        `| ${cols.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${(Array.isArray(row) ? cols.map((_, i) => esc(row[i])) : cols.map(() => '')).join(' | ')} |`),
      ];
      return <>{ctx.renderMarkdown(lines.join('\n'))}</>;
    }

    case 'Stat': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const val = resolveString(component.value, ctx.dataModel, scope);
      const delta = resolveString(component.delta, ctx.dataModel, scope);
      const tone = resolveString(component.tone, ctx.dataModel, scope);
      return (
        <div className="oc-box flex w-fit min-w-[10rem] flex-col gap-1">
          <span className="typography-meta text-muted-foreground">{label}</span>
          <span className="text-[1.625rem] font-semibold leading-tight tracking-[-0.01em] tabular-nums">{val}</span>
          {delta && (
            <span className="oc-badge w-fit tabular-nums" data-tone={tone && tone !== 'neutral' ? tone : undefined}>
              {delta}
            </span>
          )}
        </div>
      );
    }

    case 'Progress': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const valueNum = Number(resolveDynamicValue(component.value, ctx.dataModel, scope) ?? 0);
      const maxNum = Number(resolveDynamicValue(component.max, ctx.dataModel, scope) ?? 100) || 100;
      const share = Math.max(0, Math.min(1, valueNum / maxNum));
      const pct = Math.round(share * 100);
      const done = share >= 1;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 typography-meta">
            <span className="min-w-0 truncate">{label}</span>
            <span className={cn('shrink-0 font-semibold tabular-nums', done && 'text-[var(--status-success)]')}>
              {maxNum !== 100 ? `${valueNum} / ${maxNum} (${pct}%)` : `${pct}%`}
            </span>
          </div>
          <div className="oc-track h-2 overflow-hidden rounded-full" role="progressbar" aria-valuenow={valueNum} aria-valuemax={maxNum}>
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: `${share * 100}%`, background: done ? 'var(--status-success)' : seriesColor(0) }}
            />
          </div>
        </div>
      );
    }

    case 'Steps': {
      const rawItems = resolveDynamicValue(component.items, ctx.dataModel, scope);
      if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
      return (
        <div className="flex flex-col gap-2" role="list">
          {rawItems.map((entry, idx) => {
            if (!isPlainObject(entry)) return null;
            const title = resolveString(entry.title, ctx.dataModel, scope);
            const desc = resolveString(entry.markdown ?? entry.description, ctx.dataModel, scope);
            const status = resolveString(entry.status, ctx.dataModel, scope);
            return (
              <div key={idx} className="flex items-start gap-2.5" role="listitem">
                <span
                  className={cn(
                    'mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full typography-micro tabular-nums',
                    status === 'done'
                      ? 'bg-[var(--status-success)] text-background'
                      : status === 'blocked'
                        ? 'bg-[var(--status-error)] font-bold text-background'
                        : status === 'current'
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'border border-border text-muted-foreground',
                  )}
                >
                  {status === 'done' ? <Icon name="check" className="size-3" /> : status === 'blocked' ? '!' : idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('typography-meta font-medium', status === 'todo' && 'text-muted-foreground')}>{title}</div>
                  {desc && <div className="typography-micro text-muted-foreground">{ctx.renderMarkdown(desc)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    case 'ChoicePicker':
      return <A2uiChoicePicker component={component} />;

    case 'CheckBox': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const boundPath = extractBoundPath(component.value) ?? `/fields/${component.id}`;
      const checked = Boolean(getByPointer(ctx.dataModel, boundPath, scope));
      return (
        <label className={cn('flex items-center gap-2 typography-meta', ctx.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
          <Checkbox
            checked={checked}
            disabled={ctx.disabled}
            ariaLabel={label || component.id}
            onChange={(next) => {
              if (!ctx.disabled) ctx.setPath(boundPath, next, scope);
            }}
          />
          <span>{label}</span>
        </label>
      );
    }

    case 'TextField': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const placeholder = resolveString(component.placeholder, ctx.dataModel, scope);
      const variant = resolveString(component.variant, ctx.dataModel, scope);
      const boundPath = extractBoundPath(component.value) ?? `/fields/${component.id}`;
      const raw = getByPointer(ctx.dataModel, boundPath, scope);
      const val = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
      return (
        <label className="flex flex-col gap-1">
          {label && <span className="typography-meta font-medium text-foreground">{label}</span>}
          {variant === 'longText' ? (
            <Textarea
              rows={2}
              value={val}
              placeholder={placeholder}
              disabled={ctx.disabled}
              onChange={(event) => ctx.setPath(boundPath, event.target.value, scope)}
            />
          ) : (
            <FieldInput
              type={variant === 'number' ? 'number' : variant === 'obscured' ? 'password' : 'text'}
              value={val}
              placeholder={placeholder}
              disabled={ctx.disabled}
              onChange={(event) =>
                ctx.setPath(
                  boundPath,
                  variant === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value,
                  scope,
                )
              }
            />
          )}
        </label>
      );
    }

    case 'Slider': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const min = Number(component.min ?? 0);
      const max = Number(component.max ?? 100);
      const step = Number(component.step ?? 1) || 1;
      const unit = resolveString(component.unit, ctx.dataModel, scope);
      const boundPath = extractBoundPath(component.value) ?? `/fields/${component.id}`;
      const raw = Number(getByPointer(ctx.dataModel, boundPath, scope));
      const val = Number.isFinite(raw) ? raw : min;
      return (
        <label className="flex max-w-md flex-col gap-1.5">
          <span className="flex items-baseline justify-between gap-3 typography-meta">
            <span className="font-medium text-foreground">{label || component.id}</span>
            <span className="font-semibold tabular-nums text-foreground">
              {val}
              {unit ? ` ${unit}` : ''}
            </span>
          </span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={val}
            disabled={ctx.disabled}
            onChange={(event) => ctx.setPath(boundPath, Number(event.target.value), scope)}
            className={SLIDER_CLASS}
          />
        </label>
      );
    }

    case 'DateTimeInput':
      return <A2uiDateTimeInput component={component} />;

    case 'Button': {
      const label = resolveString(component.label, ctx.dataModel, scope);
      const childId = typeof component.child === 'string' ? component.child : null;
      const variant = resolveString(component.variant, ctx.dataModel, scope);
      const buttonDisabled =
        ctx.disabled || (component.disabled !== undefined && resolveBoolean(component.disabled, ctx.dataModel, scope, false));

      const handleClick = () => {
        if (buttonDisabled) return;
        const action = component.action;
        if (!isPlainObject(action)) {
          ctx.dispatchAction(label || component.id, resolveActionContext(undefined, ctx.dataModel, scope));
          return;
        }
        // Local client-side actions (zero LLM tokens): setData, openModal, closeModal
        if (isPlainObject(action.functionCall)) {
          const fn = action.functionCall;
          const fnName = typeof fn.call === 'string' ? fn.call : '';
          const fnArgs = isPlainObject(fn.args) ? fn.args : {};
          if (fnName === 'openModal' && typeof fnArgs.modalId === 'string') {
            ctx.setOpenModalId(fnArgs.modalId);
            return;
          }
          if (fnName === 'closeModal') {
            ctx.setOpenModalId(null);
            return;
          }
          if (fnName === 'setData' && typeof fnArgs.path === 'string') {
            const nextVal = resolveDynamicValue(fnArgs.value, ctx.dataModel, scope) ?? null;
            ctx.setPath(fnArgs.path, nextVal, scope);
            return;
          }
        }
        // Agent event dispatch: { event: { name, context } } or { name, context }
        const eventObj = isPlainObject(action.event) ? action.event : action;
        const eventName = typeof eventObj.name === 'string' && eventObj.name.trim() ? eventObj.name.trim() : label || 'submit';
        const resolvedContext = resolveActionContext(eventObj.context, ctx.dataModel, scope);
        ctx.dispatchAction(eventName, resolvedContext);
      };

      const uiVariant =
        variant === 'primary'
          ? 'default'
          : variant === 'destructive'
            ? 'destructive'
            : variant === 'ghost'
              ? 'ghost'
              : 'outline';

      return (
        <UiButton type="button" variant={uiVariant} className="w-fit" disabled={buttonDisabled} onClick={handleClick}>
          {childId ? <A2uiNode componentId={childId} /> : label || 'Action'}
        </UiButton>
      );
    }

    case 'LineChart': {
      const title = resolveString(component.title, ctx.dataModel, scope);
      const rawLabels = resolveDynamicValue(component.labels, ctx.dataModel, scope);
      const labels = Array.isArray(rawLabels) ? rawLabels.map(String) : [];
      const series = parseSeries(resolveDynamicValue(component.series, ctx.dataModel, scope));
      const unit = resolveString(component.unit, ctx.dataModel, scope) || undefined;
      const deltaMode = resolveString(component.deltaMode, ctx.dataModel, scope) === 'percent' ? 'percent' : 'absolute';
      return <A2uiLineChart title={title || undefined} labels={labels} series={series} unit={unit} deltaMode={deltaMode} inCard={inCard} />;
    }

    case 'BarChart': {
      const title = resolveString(component.title, ctx.dataModel, scope);
      const rawLabels = resolveDynamicValue(component.labels, ctx.dataModel, scope);
      const labels = Array.isArray(rawLabels) ? rawLabels.map(String) : [];
      const series = parseSeries(resolveDynamicValue(component.series, ctx.dataModel, scope));
      const unit = resolveString(component.unit, ctx.dataModel, scope) || undefined;
      const whole = component.whole === true;
      return <A2uiBarChart title={title || undefined} labels={labels} series={series} unit={unit} whole={whole} inCard={inCard} />;
    }

    case 'QuestionBatch': {
      const title = resolveString(component.title, ctx.dataModel, scope) || undefined;
      const description = resolveString(component.description, ctx.dataModel, scope) || undefined;
      const items = normalizeQuestionBatchItems(resolveDynamicValue(component.items, ctx.dataModel, scope));
      const answersPath = extractBoundPath(component.answersPath) ?? (typeof component.answersPath === 'string' ? component.answersPath : '/answers');
      const notesPath = extractBoundPath(component.notesPath) ?? (typeof component.notesPath === 'string' ? component.notesPath : '/notes');
      const rawAnswers = getByPointer(ctx.dataModel, answersPath, scope);
      const rawNotes = getByPointer(ctx.dataModel, notesPath, scope);
      const answers = isPlainObject(rawAnswers) ? rawAnswers : {};
      const notes = isPlainObject(rawNotes) ? rawNotes : {};
      const pageSize = typeof component.pageSize === 'number' && component.pageSize > 0 ? Math.floor(component.pageSize) : 5;
      const submitAction = typeof component.submitAction === 'string' ? component.submitAction : 'submit';
      const submitLabel = resolveString(component.submitLabel, ctx.dataModel, scope) || 'Submit selections';
      const hideSubmit = component.hideSubmit === true;

      return (
        <A2uiQuestionBatch
          title={title}
          description={description}
          items={items}
          answers={answers}
          notes={notes}
          pageSize={pageSize}
          disabled={ctx.disabled}
          submitLabel={submitLabel}
          requireAll={component.requireAll === true}
          onAnswerChange={(id, val) => ctx.setPath(joinPointer(answersPath, id), val, scope)}
          onNoteChange={(id, note) => ctx.setPath(joinPointer(notesPath, id), note, scope)}
          onApplyRecommended={(patch) => {
            const merged: A2uiObject = { ...answers, ...patch };
            ctx.setPath(answersPath, merged, scope);
          }}
          onSubmit={hideSubmit ? undefined : (payload) => ctx.dispatchAction(submitAction, payload)}
          renderMarkdown={ctx.renderMarkdown}
        />
      );
    }

    case 'CognitiveMap': {
      const title = resolveString(component.title, ctx.dataModel, scope) || undefined;
      const mapId = resolveString(component.mapId, ctx.dataModel, scope) || undefined;
      const focusNodeId = resolveString(component.focus ?? component.focusNodeId, ctx.dataModel, scope) || null;
      const dsl = resolveString(component.dsl, ctx.dataModel, scope) || undefined;
      const rawNodes = resolveDynamicValue(component.nodes, ctx.dataModel, scope);
      const rawEdges = resolveDynamicValue(component.edges, ctx.dataModel, scope);
      const rawHeight = Number(resolveDynamicValue(component.height, ctx.dataModel, scope));
      const height = Number.isFinite(rawHeight) && rawHeight >= 180 && rawHeight <= 900 ? Math.round(rawHeight) : 360;
      const rawPacing = resolveString(component.pacing, ctx.dataModel, scope);
      const pacing = rawPacing === 'auto' ? 'auto' : 'collab';
      return (
        <A2uiCognitiveMap
          title={title}
          mapId={mapId}
          focusNodeId={focusNodeId}
          height={height}
          dsl={dsl}
          rawNodes={rawNodes}
          rawEdges={rawEdges}
          pacing={pacing}
          disabled={ctx.disabled}
          isDemo={ctx.isDemo}
          onDispatchAction={ctx.dispatchAction}
        />
      );
    }

    default:
      return null;
  }
}

function A2uiNotDrawn({ source, errors }: { source: string; errors: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  return (
    <div className="flex flex-col gap-1 typography-meta">
      <div className="text-[var(--status-error)]">{t('chat.uiBlock.invalid')}</div>
      {[...new Set(errors)].map((err) => (
        <div key={err} className="text-muted-foreground">{err}</div>
      ))}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-fit items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="arrow-right-s" className={cn('size-4 shrink-0 transition-transform duration-150', open && 'rotate-90')} />
        {t('chat.uiBlock.source')}
      </button>
      <pre id={panelId} hidden={!open} dir="ltr" className="overflow-x-auto rounded-lg bg-foreground/5 p-2 typography-micro">
        <code>{source}</code>
      </pre>
    </div>
  );
}

class A2uiErrorBoundary extends React.Component<
  { source: string; fallback: React.ReactNode; onFailed?: (errors: string[]) => void; children: React.ReactNode },
  { failed: boolean; source: string }
> {
  state = { failed: false, source: this.props.source };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onFailed?.([`Failed to render A2UI surface: ${error.message}`]);
  }

  static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
    return props.source !== state.source ? { source: props.source, failed: false } : null;
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ChatA2uiMarkdown({ text, className }: { text: string; className?: string }) {
  const directory = useEffectiveDirectory() ?? '';
  return <MarkdownContent content={text} mode="static" settled directory={directory} className={cn('oc-ui-block-text', className)} />;
}

export function A2uiSurface({
  source,
  complete,
  host = NO_HOST,
  draft,
  actions,
  onNotDrawn,
  showPageNote = host.kind === 'page',
  directory: explicitDirectory,
}: {
  source: string;
  complete: boolean;
  host?: A2uiHost;
  draft?: A2uiDraftStorage;
  actions?: React.ReactNode;
  onNotDrawn?: (errors: string[]) => void;
  showPageNote?: boolean;
  directory?: string;
}) {
  const { t } = useI18n();
  const themeSystem = useOptionalThemeSystem();
  const presentation = React.useContext(MarkdownPresentationContext);
  const currentTheme = themeSystem?.currentTheme ?? presentation?.theme;

  const parsed = React.useMemo(() => parseA2uiMessages(source, complete), [source, complete]);
  const blockRef = React.useRef<HTMLDivElement>(null);

  React.useInsertionEffect(addKitStyles, []);
  React.useLayoutEffect(() => {
    const element = blockRef.current;
    if (!element || !currentTheme) return;
    for (const [name, color] of Object.entries(kitVariables(currentTheme))) {
      element.style.setProperty(name, color);
    }
  }, [currentTheme, parsed.kind]);

  const notDrawnErrors = parsed.kind === 'invalid' ? parsed.errors : null;
  React.useEffect(() => {
    if (notDrawnErrors) onNotDrawn?.(notDrawnErrors);
  }, [notDrawnErrors, onNotDrawn]);

  const [initialDraft] = React.useState(() => (host.answered ? undefined : draft?.load()));
  const [userOverrides, setUserOverrides] = React.useState<A2uiJson | null>(() => initialDraft?.dataModel ?? null);
  const [note, setNote] = React.useState(() => initialDraft?.note ?? host.answered?.note ?? '');
  const [noteOpen, setNoteOpen] = React.useState(() => note.length > 0);
  const [openModalId, setOpenModalId] = React.useState<string | null>(null);

  const { sending, sent, setSent, failed, deliver } = useBlockDelivery(host.answered !== null, draft?.save);

  const [shownAnswer, setShownAnswer] = React.useState(host.answered);
  if (host.answered !== shownAnswer) {
    setShownAnswer(host.answered);
    if (host.answered) {
      setNote(host.answered.note ?? '');
      setSent(true);
    }
  }

  // Merge parsed surface data model with user edits; when answered, overlay saved answers if present.
  const baseDataModel = React.useMemo<A2uiJson>(
    () => (parsed.kind === 'ready' ? parsed.surface.dataModel : {}),
    [parsed],
  );
  const dataModel: A2uiJson = React.useMemo(() => {
    if (userOverrides !== null) return userOverrides;
    if (host.answered && isPlainObject(baseDataModel)) {
      const merged: A2uiObject = { ...baseDataModel };
      if (isPlainObject(host.answered.context.answers)) merged.answers = host.answered.context.answers;
      if (isPlainObject(host.answered.context.notes)) merged.notes = host.answered.context.notes;
      return merged;
    }
    return baseDataModel;
  }, [baseDataModel, host.answered, userOverrides]);

  // Persist unsent edits to sessionStorage so reloading mid-questionnaire loses no progress.
  React.useEffect(() => {
    if (!draft || sent || host.answered !== null || userOverrides === null) return;
    draft.save({ dataModel: userOverrides, note });
  }, [draft, host.answered, note, sent, userOverrides]);

  const disabled = !host.submit || !complete || sending || sent;

  const setPath = React.useCallback(
    (path: string, value: A2uiJson, scope = '') => {
      setUserOverrides((previous) => {
        const current = previous ?? baseDataModel;
        return setByPointer(current, path, value, scope);
      });
    },
    [baseDataModel],
  );

  const dispatchAction = React.useCallback(
    (actionName: string, context: A2uiObject) => {
      if (disabled || !host.submit || parsed.kind !== 'ready') return;
      const trimmedNote = note.trim();
      const answer: A2uiAnswerData = {
        action: actionName,
        surfaceId: parsed.surface.surfaceId,
        context,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      };
      const summary = formatA2uiSummary(actionName, context, trimmedNote || undefined);

      if (host.kind === 'page') {
        const submit = host.submit;
        void deliver(() => submit({ summary, data: answer }));
      } else if (host.kind === 'reply') {
        const submit = host.submit;
        void deliver(() => submit(answer, describeA2uiReplyAnswer(answer)));
      } else {
        const submit = host.submit;
        void deliver(() => submit(answer, summary));
      }
    },
    [deliver, disabled, host, note, parsed],
  );

  const renderMarkdown = React.useCallback(
    (text: string, className?: string) => {
      if (!text) return null;
      if (presentation?.purpose === 'image') {
        return (
          <MarkdownContent
            content={text}
            purpose="image"
            theme={presentation.theme}
            preparedHighlights={presentation.preparedHighlights}
            onExportCode={presentation.onExportCode}
            className={cn('oc-ui-block-text', className)}
          />
        );
      }
      if (host.kind === 'demo' || explicitDirectory !== undefined) {
        return (
          <MarkdownContent
            content={text}
            mode="static"
            settled
            directory={explicitDirectory ?? ''}
            enableFileReferences={false}
            className={cn('oc-ui-block-text', className)}
          />
        );
      }
      return <ChatA2uiMarkdown text={text} className={className} />;
    },
    [explicitDirectory, host.kind, presentation],
  );

  const surfaceContext = React.useMemo<SurfaceContextValue | null>(() => {
    if (parsed.kind !== 'ready') return null;
    return {
      surface: parsed.surface,
      dataModel,
      disabled,
      isDemo: host.kind === 'demo',
      setPath,
      dispatchAction,
      openModalId,
      setOpenModalId,
      renderMarkdown,
    };
  }, [dataModel, disabled, dispatchAction, host.kind, openModalId, parsed, renderMarkdown, setPath]);

  const fallback = <A2uiNotDrawn source={source} errors={notDrawnErrors ?? []} />;
  if (parsed.kind === 'invalid') return fallback;
  if (parsed.kind === 'empty' || !surfaceContext) return null;

  return (
    <div ref={blockRef} data-oc-a2ui-surface={parsed.surface.surfaceId} className="oc-ui-block my-3 flex flex-col gap-2">
      <A2uiErrorBoundary source={source} fallback={fallback} onFailed={onNotDrawn}>
        <SurfaceContext.Provider value={surfaceContext}>
          <A2uiNode componentId={parsed.surface.rootId} />
        </SurfaceContext.Provider>
      </A2uiErrorBoundary>

      {showPageNote && Boolean(host.submit || note) && (
        <div className="pt-1">
          {noteOpen || note ? (
            <Textarea
              rows={2}
              maxLength={4000}
              value={note}
              disabled={disabled}
              placeholder={t('chat.uiBlock.note.placeholder')}
              aria-label={t('chat.uiBlock.note.label')}
              onChange={(event) => setNote(event.target.value)}
              className="min-h-10"
            />
          ) : !disabled ? (
            <UiButton
              type="button"
              variant="ghost"
              size="xs"
              className="w-fit px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() => setNoteOpen(true)}
            >
              <Icon name="add" className="size-3.5" />
              {t('chat.uiBlock.note.add')}
            </UiButton>
          ) : null}
        </div>
      )}

      {actions ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <fieldset disabled={disabled} className="contents">{actions}</fieldset>
        </div>
      ) : null}

      {host.kind === 'reply' && (sent || failed) && (
        <div className="flex min-h-5 items-center gap-2 typography-meta text-muted-foreground" aria-live="polite" data-export-ignore>
          {failed ? (
            <span className="text-[var(--status-error)]">{t('chat.uiBlock.sendFailed')}</span>
          ) : sent ? (
            <span className="inline-flex items-center gap-1 text-[var(--status-success)]">
              <Icon name="check" className="size-3.5" />
              {t('chat.uiBlock.sent')}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
