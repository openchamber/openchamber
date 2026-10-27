import React from 'react';
import { z } from 'zod/v4';
import {
  parseStructuredRules,
  useFormName,
  useFormValidation,
  useGetFieldValue,
  useIsStreaming,
  useSetDefaultValue,
  useSetFieldValue,
  useStateField,
  useTriggerAction,
  type ComponentRenderProps,
} from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Radio } from '@base-ui/react/radio';
import { Slider } from '@base-ui/react/slider';
import { Tabs } from '@base-ui/react/tabs';
import { BarChart, LineChart, AreaChart, PieChart, type BaseChartProps, type ChartData } from '@openuidev/react-ui/Charts';
import { Carousel, CarouselContent, CarouselItem, type CarouselRef } from '@openuidev/react-ui/Carousel';
import { Card } from '@openuidev/react-ui/Card';
import { Tag } from '@openuidev/react-ui/Tag';
import * as RemixIcons from '@remixicon/react';
import type { OpenUIProps } from './openuiProps';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { MarkdownContent } from '@/components/chat/MarkdownRendererImpl';
import { iconOptions, chartOptions, barOptions, pieOptions, layoutOptions } from './openuiCatalog.schema';
import { OpenUIOccurrence as Occurrence, useOpenUIHost } from './openuiHost';
import { isSupportedOpenUIAction, isTerminalOpenUIAction } from '../../../../../web/shared/openui/actions.js';
import './openui.css';

type Props<N extends keyof OpenUIProps> = OpenUIProps[N];
type Render<N extends keyof OpenUIProps> = ComponentRenderProps<Props<N>>;
type Rules = Props<'Input'>['rules'];

const OpenUIHtmlView = React.lazy(async () => {
  const module = await import('@/components/chat/message/parts/OpenUIHtmlView');
  return { default: module.OpenUIHtmlView };
});

export function ChamberHtmlView({ props }: Render<'HtmlView'>) {
  const streaming = useIsStreaming();
  if (streaming) return null;
  return (
    <React.Suspense fallback={null}>
      <OpenUIHtmlView html={props.html} height={props.height} title={props.title} />
    </React.Suspense>
  );
}

function useInteractionGate() {
  const { host } = useOpenUIHost();
  const latest = React.useRef(host);
  const mounted = React.useRef(true);
  latest.current = host;
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const canInteract = React.useCallback(() => mounted.current && latest.current.canInteract(), []);
  const streaming = useIsStreaming();
  return { canInteract, disabled: !host.canInteract() || streaming };
}

// DOM labels need mount-local IDs; persisted page identity uses occurrence paths.
const FieldLabelContext = React.createContext<{ id: string; labelId: string; descriptionId: string } | null>(null);

function useField<T>(name: string, value: T, rulesValue: Rules, componentType: string, defaultValue?: T) {
  const field = useStateField(name, value);
  const formName = useFormName();
  const getFieldValue = useGetFieldValue();
  const setFieldValue = useSetFieldValue();
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const gate = useInteractionGate();
  const rules = React.useMemo(() => parseStructuredRules(rulesValue), [rulesValue]);
  const fieldId = React.useId();
  const label = React.useContext(FieldLabelContext);
  const id = label?.id ?? fieldId;
  const setValue: typeof field.setValue = (next) => {
    if (field.isReactive) field.setValue(next);
    else setFieldValue(formName, componentType, name, next);
  };
  useSetDefaultValue({
    formName, componentType, name, existingValue: getFieldValue(formName, name),
    defaultValue: field.isReactive ? undefined : field.value ?? defaultValue,
  });
  React.useEffect(() => {
    if (streaming || !validation || !rules.length) return;
    validation.registerField(name, rules, () => field.value ?? defaultValue);
    return () => validation.unregisterField(name);
  }, [name, field.value, validation, rules, streaming, defaultValue]);
  return {
    field: { ...field, setValue }, id, labelId: label?.labelId,
    descriptionId: label?.descriptionId, validation, rules, ...gate,
    change: (next: Parameters<typeof field.setValue>[0]) => {
      if (!gate.canInteract()) return;
      setValue(next);
      validation?.validateField(name, next, rules);
    },
  };
}

function useTextField(props: Props<'Input'> | Props<'TextArea'>, componentType: 'Input' | 'TextArea') {
  const { field, id, descriptionId, validation, rules, canInteract, disabled } = useField(
    props.name, props.value, props.rules, componentType,
  );
  return {
    id,
    name: field.name,
    value: field.value ?? '',
    placeholder: props.placeholder,
    disabled,
    'aria-invalid': Boolean(validation?.getFieldError(field.name)),
    'aria-describedby': descriptionId,
    'aria-required': props.rules?.required,
    onFocus: () => validation?.clearFieldError(field.name),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!canInteract()) return;
      field.setValue(event.target.value);
      validation?.clearFieldError(field.name);
    },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (canInteract()) validation?.validateField(field.name, event.target.value, rules);
    },
  };
}

export function ChamberInput({ props }: Render<'Input'>) {
  const field = useTextField(props, 'Input');
  return <Input {...field} type={props.type ?? 'text'} />;
}

export function ChamberTextArea({ props }: Render<'TextArea'>) {
  const field = useTextField(props, 'TextArea');
  return <Textarea {...field} simple rows={props.rows ?? 3} />;
}

function useAction(action: OpenUIProps['Button']['action'], label: string) {
  const triggerAction = useTriggerAction();
  const formName = useFormName();
  const validation = useFormValidation();
  const gate = useInteractionGate();
  return {
    disabled: gate.disabled || !isSupportedOpenUIAction(action),
    onClick: () => {
      // Reactive props may change after admission. Validate the actual plan again at the event.
      if (!gate.canInteract() || !isSupportedOpenUIAction(action)) return;
      if (isTerminalOpenUIAction(action) && validation && !validation.validateForm()) return;
      triggerAction(label, formName, action);
    },
  };
}

export function ChamberButton({ props }: Render<'Button'>) {
  const action = useAction(props.action, props.label);
  const variant = props.type === 'destructive' ? 'destructive'
    : props.variant === 'secondary' ? 'secondary' : props.variant === 'tertiary' ? 'ghost' : 'default';
  const size = props.size === 'extra-small' ? 'xs' : props.size === 'small' ? 'sm' : props.size === 'large' ? 'lg' : 'default';
  return <Button variant={variant} size={size} {...action}>{props.label}</Button>;
}

export function ChamberIconButton({ props, renderNode }: Render<'IconButton'>) {
  const action = useAction(props.action, props.name ?? '');
  const size = props.size === 'extra-small' ? 'xs' : props.size === 'small' ? 'sm' : props.size === 'large' ? 'lg' : 'icon';
  const variant = props.variant === 'primary' ? 'default' : props.variant === 'tertiary' ? 'ghost' : 'secondary';
  return (
    <Button variant={variant} size={size} aria-label={props.name} className={props['shape'] === 'circle' ? 'aspect-square rounded-full' : 'aspect-square'} {...action}>
      {renderNode(props.icon)}
    </Button>
  );
}

function EmbeddedMarkdown({ text }: { text?: string }) {
  const { host } = useOpenUIHost();
  return <MarkdownContent content={text ?? ''} embedded directory={host.owner.directory} enableFileReferences={false} />;
}

export function ChamberTextContent({ props }: Render<'TextContent'>) {
  return <div className="openui-inert-markdown" data-size={props.size ?? 'default'}><EmbeddedMarkdown text={props.text} /></div>;
}

export function ChamberCallout({ props }: Render<'Callout'>) {
  const field = useStateField<boolean | string | undefined>('visible', props.visible);
  const { canInteract, disabled } = useInteractionGate();
  const visible = !field.isReactive || field.value === true || field.value === 'true';
  const latestField = React.useRef(field);
  latestField.current = field;
  React.useEffect(() => {
    if (disabled || !field.isReactive || !visible) return;
    const timer = setTimeout(() => { if (canInteract()) latestField.current.setValue(false); }, 3000);
    return () => clearTimeout(timer);
  }, [canInteract, disabled, field.isReactive, visible]);
  if (!visible) return null;
  return (
    <div className="oc-tile-inset openui-callout" data-tone={props.variant}>
      <strong>{props.title}</strong>
      <EmbeddedMarkdown text={props.description} />
    </div>
  );
}

function renderOccurrences(renderNode: Render<'Stack'>['renderNode'], value: Parameters<Render<'Stack'>['renderNode']>[0], slot: string) {
  const children: unknown[] = Array.isArray(value) ? value : [value];
  return children.map((child, index) => (
    <Occurrence key={`${slot}/${index}`} occurrence={`${slot}/${index}`}>
      {Array.isArray(child) ? renderOccurrences(renderNode, child, 'items') : renderNode(child)}
    </Occurrence>
  ));
}

export function ChamberForm({ props, renderNode }: Render<'Form'>) {
  const Official = openuiLibrary.components.Form.component;
  return (
    <Official
      props={props}
      renderNode={(value) => (
        value === props.fields
          ? renderOccurrences(renderNode, value, 'fields')
          : <Occurrence occurrence="buttons">{renderNode(value)}</Occurrence>
      )}
    />
  );
}

export function ChamberFormControl({ props, renderNode }: Render<'FormControl'>) {
  const validation = useFormValidation();
  const id = React.useId();
  const name = props.input?.props.name;
  const label = React.useMemo(() => ({ id, labelId: `${id}-label`, descriptionId: `${id}-description` }), [id]);
  const error = name ? validation?.getFieldError(name) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label id={label.labelId} className="typography-ui-label text-foreground" htmlFor={id}>
        {props.label}{props.input?.props.rules?.required ? ' *' : ''}
      </label>
      <FieldLabelContext.Provider value={label}>
        <Occurrence occurrence="input">{renderNode(props.input)}</Occurrence>
      </FieldLabelContext.Provider>
      <div id={label.descriptionId} className="min-h-5 typography-meta text-muted-foreground" role={error ? 'alert' : undefined}>
        {error ?? props.hint}
      </div>
    </div>
  );
}

export function ChamberSelect({ props }: Render<'Select'>) {
  const { field, id, descriptionId, validation, disabled, change } = useField(props.name, props.value, props.rules, 'Select');
  const selected = props.items.find((item) => item.props.value === field.value)?.props.label;
  return (
    <Select name={field.name} value={field.value ?? ''} disabled={disabled} onValueChange={change}>
      <SelectTrigger id={id} aria-describedby={descriptionId} aria-invalid={Boolean(validation?.getFieldError(field.name))}
        className="max-w-full" data-size={props.size}>
        <SelectValue placeholder={props.placeholder}>{selected}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {props.items.map((item) => <SelectItem key={item.props.value} value={item.props.value}>{item.props.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function ChamberCheckBoxGroup({ props }: Render<'CheckBoxGroup'>) {
  const defaults = React.useMemo(() => Object.fromEntries<boolean>(props.items.map(({ props: item }) => [item.name, item.defaultChecked ?? false])), [props.items]);
  const { field, id, labelId, descriptionId, change, disabled } = useField(props.name, props.value, props.rules, 'CheckBoxGroup', defaults);
  const current = { ...defaults, ...field.value };
  return (
    <div id={id} aria-labelledby={labelId} aria-describedby={descriptionId} className="flex flex-col gap-2" role="group">
      {props.items.map(({ props: item }) => (
        <div key={item.name} className="flex items-center gap-2" onClick={() => { if (!disabled) change({ ...current, [item.name]: !current[item.name] }); }}>
          <Checkbox checked={current[item.name] ?? false} disabled={disabled} ariaLabel={item.label}
            onChange={(next) => change({ ...current, [item.name]: next })} />
          <span>{item.label}{item.description && <span className="block typography-meta text-muted-foreground">{item.description}</span>}</span>
        </div>
      ))}
    </div>
  );
}

export function ChamberSwitchGroup({ props }: Render<'SwitchGroup'>) {
  const defaults = React.useMemo(() => Object.fromEntries<boolean>(props.items.map(({ props: item }) => [item.name, item.defaultChecked ?? false])), [props.items]);
  const { field, id, change, disabled } = useField(props.name, props.value, undefined, 'SwitchGroup', defaults);
  const current = { ...defaults, ...field.value };
  return (
    <div id={id} className={`flex flex-col gap-2 ${props.variant === 'card' ? 'oc-tile' : props.variant === 'sunk' ? 'oc-tile-inset' : ''}`} role="group">
      {props.items.map(({ props: item }) => (
        <div key={item.name} className="flex items-center gap-2" onClick={() => { if (!disabled) change({ ...current, [item.name]: !current[item.name] }); }}>
          <span className="contents" onClick={(event) => event.stopPropagation()}>
            <Switch aria-label={item.label ?? item.name} checked={current[item.name] ?? false} disabled={disabled} onCheckedChange={(next) => change({ ...current, [item.name]: next })} />
          </span>
          <span>{item.label}{item.description && <span className="block typography-meta text-muted-foreground">{item.description}</span>}</span>
        </div>
      ))}
    </div>
  );
}

// The DSL names Remix exports in kebab-case; retain the official Line/Fill variants.
const remixIcons = new Map(Object.entries(RemixIcons).map(([name, component]) => [name.slice(2).toLowerCase(), component]));

export function OpenUIIcon({ props }: Render<'Icon'>) {
  if (!props.name) return null;
  const Component = remixIcons.get(props.name.replaceAll('-', '').toLowerCase());
  if (!Component) return null;
  const options = iconOptions.safeParse(props.options).data;
  const sizes = { sm: 'size-3.5', md: 'size-4', lg: 'size-5', xl: 'size-6' };
  const tones = {
    default: '',
    muted: 'text-muted-foreground',
    info: 'text-[var(--status-info-text)]',
    success: 'text-[var(--status-success-text)]',
    warning: 'text-[var(--status-warning-text)]',
    danger: 'text-[var(--status-error-text)]',
  };
  return <Component aria-hidden="true" className={`${sizes[options?.size ?? 'md']} ${tones[options?.tone ?? 'default']}`} />;
}

export function ChamberTag({ props, renderNode }: Render<'Tag'>) {
  return <Tag {...props} icon={renderNode(props.icon)} />;
}

function useChoices(props: Props<'Chips'> | Props<'OptionCards'>, componentType: 'Chips' | 'OptionCards') {
  const fallback = React.useMemo(() => props.type === 'multiple'
    ? Array.isArray(props.defaultValue) ? props.defaultValue : props.defaultValue === undefined ? undefined : props.defaultValue ? [props.defaultValue] : []
    : (Array.isArray(props.defaultValue) ? props.defaultValue[0] : props.defaultValue) || undefined, [props.type, props.defaultValue]);
  const control = useField<string | string[] | undefined>(props.name, undefined, props.rules, componentType, fallback);
  const current = control.field.value ?? fallback;
  const selected = Array.isArray(current) ? current : current ? [current] : [];
  return {
    id: control.id,
    labelId: control.labelId,
    descriptionId: control.descriptionId,
    disabled: control.disabled,
    selected,
    toggle: (value: string) => {
      const chosen = selected.includes(value);
      const next = props.type === 'multiple'
        ? chosen ? selected.filter((entry) => entry !== value) : [...selected, value]
        : chosen ? '' : value;
      control.change(next);
    },
  };
}

export function ChamberChips({ props, renderNode }: Render<'Chips'>) {
  const control = useChoices(props, 'Chips');
  return (
    <div id={control.id} aria-labelledby={control.labelId} aria-describedby={control.descriptionId} role="group" className="flex flex-wrap gap-2">
      {props.items.map(({ props: item }) => (
        <Button key={item.value} variant="chip" aria-pressed={control.selected.includes(item.value)}
          disabled={control.disabled || item.disabled} onClick={() => control.toggle(item.value)}>
          {renderNode(item.icon)}{item.label}
        </Button>
      ))}
    </div>
  );
}

export function ChamberOptionCards({ props, renderNode }: Render<'OptionCards'>) {
  const control = useChoices(props, 'OptionCards');
  return (
    <div id={control.id} aria-labelledby={control.labelId} aria-describedby={control.descriptionId} role="group" className="openui-option-grid">
      {props.items.map(({ props: item }, index) => (
        <div key={item.value} className="openui-option oc-tile" data-selected={control.selected.includes(item.value) || undefined}
          data-disabled={control.disabled || item.disabled || undefined}>
          <Occurrence occurrence={`items/${index}/topContent`}>{renderNode(item.topContent)}</Occurrence>
          <button type="button" className="text-start font-medium after:absolute after:inset-0 after:rounded-[inherit]"
            aria-pressed={control.selected.includes(item.value)} disabled={control.disabled || item.disabled}
            onClick={() => control.toggle(item.value)}>{item.title}</button>
          {item.subtitle && <span className="typography-meta text-muted-foreground">{item.subtitle}</span>}
        </div>
      ))}
    </div>
  );
}

export function ChamberRadioGroup({ props }: Render<'RadioGroup'>) {
  const { field, id, labelId, descriptionId, disabled, change } = useField(props.name, props.value, props.rules, 'RadioGroup', props.defaultValue);
  return (
    <RadioGroup id={id} aria-labelledby={labelId} aria-describedby={descriptionId} name={field.name}
      value={field.value ?? props.defaultValue ?? ''} disabled={disabled} onValueChange={change} className="flex flex-col gap-2">
      {props.items.map(({ props: item }) => (
        <label key={item.value} className="openui-radio-row">
          <Radio.Root value={item.value} className="openui-radio">
            <Radio.Indicator className="size-1.5 rounded-full bg-foreground" />
          </Radio.Root>
          <span className="min-w-0"><span className="font-medium">{item.label}</span>
            {item.description && <span className="block typography-meta text-muted-foreground">{item.description}</span>}
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

const selectedDateRange = z.object({ from: z.date().optional(), to: z.date().optional() });

export function ChamberDatePicker({ props }: Render<'DatePicker'>) {
  const { field, id, labelId, descriptionId, disabled, change } = useField(props.name, props.value, props.rules, 'DatePicker');
  const range = props.mode === 'range';
  const selected = selectedDateRange.safeParse(field.value).data;
  const dates = range ? [selected?.from, selected?.to] : [field.value instanceof Date ? field.value : undefined];
  const { t } = useI18n();
  return (
    <fieldset aria-labelledby={labelId} aria-describedby={descriptionId} disabled={disabled} className="flex min-w-0 flex-wrap gap-2">
      {dates.map((date, index) => (
        <Input key={index} id={index === 0 ? id : `${id}-end`} type="date" className="w-auto max-w-full flex-1"
          aria-labelledby={!range ? labelId : undefined}
          aria-label={range || !labelId ? t(range ? index === 0 ? 'chat.openui.startDate' : 'chat.openui.endDate' : 'chat.openui.date') : undefined}
          aria-describedby={descriptionId} disabled={disabled}
          value={date && Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : ''}
          onChange={(event) => {
            const value = event.target.value ? new Date(`${event.target.value}T00:00:00`) : undefined;
            change(range ? { from: index === 0 ? value : selected?.from, to: index === 1 ? value : selected?.to } : value ?? null);
          }} />
      ))}
    </fieldset>
  );
}

export function ChamberSlider({ props }: Render<'Slider'>) {
  const fallback = React.useMemo(() => props.defaultValue ?? [props.min], [props.defaultValue, props.min]);
  const { field, id, labelId, descriptionId, disabled, change } = useField(props.name, props.value, props.rules, 'Slider', fallback);
  const values = field.value ?? fallback;
  const { t, locale } = useI18n();
  const label = props.label ?? field.name;
  const step = props.step && props.step > 0 ? props.step : 1;
  const optionCount = Math.floor((props.max - props.min) / step) + 1;
  const discreteOptions = props.variant === 'discrete' && optionCount > 0 && optionCount <= 100;
  const setNumber = (index: number, value: number) => {
    const snapped = props.min + Math.round((value - props.min) / step) * step;
    const next = values.map((current, position) => position === index ? Math.min(props.max, Math.max(props.min, Number(snapped.toFixed(10)))) : current);
    change(next.sort((a, b) => a - b));
  };
  return (
    <div id={id} aria-labelledby={labelId} aria-describedby={descriptionId} className="openui-slider-field">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!labelId && <span className="typography-ui-label font-medium">{label}</span>}
        <div className="ms-auto flex gap-2">
          {values.map((value, index) => (
            discreteOptions ? <Select key={index} value={String(value)} disabled={disabled}
              onValueChange={(next) => setNumber(index, Number(next))}>
              <SelectTrigger aria-label={values.length > 1 ? t(index === 0 ? 'chat.openui.minimum' : 'chat.openui.maximum') : label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{Array.from({ length: optionCount }, (_, position) => {
                const option = Number((props.min + position * step).toFixed(10));
                return <SelectItem key={option} value={String(option)}>{option}</SelectItem>;
              })}</SelectContent>
            </Select> : <Input key={index} type="number" value={value} min={props.min} max={props.max} step={step}
              inputSize="compact" className="w-20 tabular-nums" disabled={disabled}
              aria-label={values.length > 1 ? t(index === 0 ? 'chat.openui.minimum' : 'chat.openui.maximum') : label}
              aria-describedby={descriptionId} onChange={(event) => {
                if (Number.isFinite(event.target.valueAsNumber)) setNumber(index, event.target.valueAsNumber);
              }} />
          ))}
        </div>
      </div>
      <Slider.Root value={values} min={props.min} max={props.max} step={step} disabled={disabled}
        onValueChange={change} locale={locale} className="min-w-0">
        <Slider.Control className="openui-slider-control">
          <Slider.Track className="openui-slider-track"><Slider.Indicator className="openui-slider-indicator" /></Slider.Track>
          {values.map((_, index) => <Slider.Thumb key={index} index={index} className="openui-slider-thumb oc-raised bg-[var(--surface-background)] dark:bg-surface-elevated"
            getAriaLabel={() => values.length > 1 ? t(index === 0 ? 'chat.openui.minimum' : 'chat.openui.maximum') : label} />)}
        </Slider.Control>
      </Slider.Root>
      <div className="flex justify-between typography-meta text-muted-foreground tabular-nums"><span>{props.min}</span><span>{props.max}</span></div>
    </div>
  );
}

export function ChamberTable({ props, renderNode }: Render<'Table'>) {
  const { t } = useI18n();
  const [page, setPage] = React.useState(0);
  const columns = props.columns.map(({ props: column }) => ({ ...column, data: Array.isArray(column.data) ? column.data : column.data == null ? [] : [column.data] }));
  const count = Math.max(0, ...columns.map((column) => column.data.length));
  const pages = Math.max(1, Math.ceil(count / 10));
  const current = Math.min(page, pages - 1);
  return (
    <div className="openui-table-container">
      <div className="openui-table-scroll"><table className="openui-data-table">
        <thead><tr>{columns.map((column, index) => <th key={index} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>{Array.from({ length: Math.min(10, count - current * 10) }, (_, index) => (
          <tr key={current * 10 + index}>{columns.map((column, col) => (
            <td key={col}><Occurrence occurrence={`columns/${col}/data/${current * 10 + index}`}>
              {Array.isArray(column.data[current * 10 + index])
                ? renderOccurrences(renderNode, column.data[current * 10 + index], 'items')
                : renderNode(column.data[current * 10 + index])}
            </Occurrence></td>
          ))}</tr>
        ))}</tbody>
      </table></div>
      {pages > 1 && <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="xs" variant="ghost" aria-label={t('chat.openui.previousPage')} disabled={current === 0}
          onClick={() => setPage((value) => Math.max(0, value - 1))}>
          <Icon name="arrow-left-s" className="size-4" />
        </Button>
        <span className="typography-meta text-muted-foreground">{current + 1} / {pages}</span>
        <Button size="xs" variant="ghost" aria-label={t('chat.openui.nextPage')} disabled={current === pages - 1}
          onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>
          <Icon name="arrow-right-s" className="size-4" />
        </Button>
      </div>}
    </div>
  );
}

function renderCartesianChart(
  props: Props<'BarChart'> | Props<'LineChart'>,
  options: Props<'LineChart'>['options'],
  renderChart: (props: BaseChartProps<ChartData>) => React.ReactNode,
) {
  // The label field must never overwrite a series named "label".
  let categoryKey = '__category';
  const series = props.series ?? [];
  while (series.some((item) => item.props.category === categoryKey)) categoryKey += '_';
  const data = (props.labels ?? []).map((label, index) => ({
    [categoryKey]: label,
    ...Object.fromEntries(series.map(({ props: series }) => [
      series.category, series.values?.[index] ?? 0,
    ])),
  }));
  return (
    <div dir="ltr">
      {renderChart({
        data,
        categoryKey,
        xAxisLabel: props.xLabel,
        yAxisLabel: props.yLabel,
        height: props.height,
        condensed: options?.layout !== 'scroll',
        isAnimationActive: false,
        density: options?.density,
        legend: options?.legend,
        grid: options?.grid,
        showYAxis: options?.showYAxis,
        tickVariant: options?.tickVariant,
        customPalette: options?.palette?.map((index) => `var(--chart-${index})`),
      })}
      {options?.legend === false && (props.xLabel || props.yLabel) && (
        <p className="typography-meta text-muted-foreground">
          {[props.xLabel, props.yLabel].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}

export function ChamberBarChart({ props }: Render<'BarChart'>) {
  const options = barOptions.safeParse(props.options).data;
  return renderCartesianChart(props, options, (chart) => (
    <BarChart {...chart} orientation={options?.orientation} variant={props.variant} />
  ));
}

export function ChamberLineChart({ props }: Render<'LineChart'>) {
  return renderCartesianChart(props, chartOptions.safeParse(props.options).data, (chart) => (
    <LineChart {...chart} variant={props.variant} />
  ));
}

export function ChamberAreaChart({ props }: Render<'AreaChart'>) {
  return renderCartesianChart(props, chartOptions.safeParse(props.options).data, (chart) => (
    <AreaChart {...chart} variant={props.variant} />
  ));
}

export function ChamberPieChart({ props }: Render<'PieChart'>) {
  const data = (props.labels ?? []).map((label, index) => ({ label, value: props.values?.[index] ?? 0 }));
  const options = pieOptions.safeParse(props.options).data;
  return (
    <div dir="ltr">
      <PieChart
        data={data}
        categoryKey="label"
        dataKey="value"
        variant={props.variant}
        appearance={props.appearance}
        isAnimationActive={false}
        legend={options?.legend}
        customPalette={options?.palette?.map((index) => `var(--chart-${index})`)}
      />
    </div>
  );
}

function openUIFlexStyle(props: OpenUIProps['Stack'], card = false): React.CSSProperties {
  const align = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch', baseline: 'baseline' };
  const justify = {
    start: 'flex-start', end: 'flex-end', center: 'center',
    between: 'space-between', around: 'space-around', evenly: 'space-evenly',
  };
  const options = layoutOptions.safeParse(props.options).data ?? {};
  const size = (length: typeof options.width) => (
    typeof length === 'number' ? `${length}rem` : length === 'full' ? '100%' : length
  );
  const gap = (spacing: NonNullable<OpenUIProps['Stack']['gap']>) => (
    spacing === 'none' ? '0px' : `var(--openui-space-${spacing})`
  );
  return {
    display: 'flex',
    flexDirection: props.direction ?? 'column',
    gap: gap(props.gap ?? 'm'),
    alignItems: props.align ? align[props.align] : card ? 'stretch' : undefined,
    justifyContent: !card && props.wrap && props.justify === 'between'
      ? 'flex-start'
      : props.justify ? justify[props.justify] : card ? 'flex-start' : undefined,
    flexWrap: props.wrap ? 'wrap' : card ? 'nowrap' : undefined,
    inlineSize: size(options.width),
    maxInlineSize: size(options.maxWidth),
    minInlineSize: size(options.minWidth) ?? (card ? 0 : undefined),
    flexGrow: options.grow ?? (card ? 1 : undefined),
    flexShrink: options.shrink ?? (card ? 1 : undefined),
    flexBasis: card ? '0%' : undefined,
    padding: options.padding ? gap(options.padding) : undefined,
  };
}

export function ChamberStack({ props, renderNode }: Render<'Stack'>) {
  // Options only change styles; switching component types would remount children.
  return (
    <div className={props.options ? 'openui-layout' : undefined} style={openUIFlexStyle(props)}>
      {renderOccurrences(renderNode, props.children, 'children')}
    </div>
  );
}

export function ChamberCard({ props, renderNode }: Render<'Card'>) {
  // The extended schema admits HtmlView; the official visual primitive retains flex/variant semantics.
  return (
    <Card
      variant={props.variant}
      width="full"
      className={props.options ? 'openui-layout' : undefined}
      style={openUIFlexStyle(props, true)}
    >
      {renderOccurrences(renderNode, props.children, 'children')}
    </Card>
  );
}

export function ChamberCarousel({ props, renderNode }: Render<'Carousel'>) {
  const { t, direction } = useI18n();
  const ref = React.useRef<CarouselRef>(null);
  const [index, setIndex] = React.useState(0);
  const items = props.children ?? [];
  const current = Math.min(index, Math.max(0, items.length - 1));
  const move = (next: number) => {
    const position = Math.max(0, Math.min(items.length - 1, next));
    setIndex(position);
    ref.current?.scrollDivRef.current?.children[position]?.scrollIntoView({
      block: 'nearest', inline: 'start', behavior: 'instant',
    });
  };
  return (
    <div
      className="openui-carousel-host"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget && event.target !== ref.current?.scrollDivRef.current) return;
        const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
        const backward = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
        if (event.key === forward || event.key === backward) {
          event.preventDefault();
          move(current + (event.key === forward ? 1 : -1));
        }
      }}
    >
      <Carousel ref={ref} variant={props.variant} showButtons={false}>
        <CarouselContent tabIndex={0} onScroll={(event) => {
          // Geometry compares physical edges, so both RTL scroll conventions work.
          const container = event.currentTarget;
          const edge = container.getBoundingClientRect();
          const children = Array.from(container.children);
          const last = children.at(-1)?.getBoundingClientRect();
          const endDistance = last && (direction === 'rtl' ? last.left - edge.left : last.right - edge.right);
          // The last short card cannot align with the start edge once scrolling
          // reaches its limit. Recognize the end before choosing the nearest start.
          if (last && container.scrollWidth > container.clientWidth && Math.abs(endDistance ?? Infinity) <= 1) {
            setIndex(children.length - 1);
            return;
          }
          let closest = 0;
          let distance = Infinity;
          children.forEach((child, i) => {
            const box = child.getBoundingClientRect();
            const delta = Math.abs(direction === 'rtl' ? edge.right - box.right : edge.left - box.left);
            if (delta < distance) {
              distance = delta;
              closest = i;
            }
          });
          setIndex(closest);
        }}>
          {items.map((item, i) => (
            <CarouselItem key={i}>{renderOccurrences(renderNode, item, `children/${i}`)}</CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
      {items.length > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('chat.openui.previousPage')}
            disabled={current === 0}
            onClick={() => move(current - 1)}
          >
            <Icon name={direction === 'rtl' ? 'arrow-right-s' : 'arrow-left-s'} className="size-4" />
          </Button>
          <span className="typography-meta text-muted-foreground">{current + 1} / {items.length}</span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('chat.openui.nextPage')}
            disabled={current >= items.length - 1}
            onClick={() => move(current + 1)}
          >
            <Icon name={direction === 'rtl' ? 'arrow-left-s' : 'arrow-right-s'} className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function ChamberTabs({ props, renderNode }: Render<'Tabs'>) {
  const [active, setActive] = React.useState('');
  const interacted = React.useRef(false);
  const sizes = React.useRef(new Map<string, number>());
  React.useEffect(() => {
    if (interacted.current) return;
    let candidate = '';
    const next = new Map<string, number>();
    for (const { props: item } of props.items) {
      const size = JSON.stringify(item.content).length;
      next.set(item.value, size);
      if (size > (sizes.current.get(item.value) ?? 0)) candidate = item.value;
    }
    sizes.current = next;
    if (candidate) setActive(candidate);
    else if (!active && props.items[0]) setActive(props.items[0].props.value);
  }, [active, props.items]);
  return (
    <Tabs.Root value={active} onValueChange={(value) => { interacted.current = true; setActive(String(value)); }} className="openui-tabs">
      <Tabs.List activateOnFocus className="openui-tab-list oc-recessed">{props.items.map(({ props: item }) => (
        <Tabs.Tab key={item.value} value={item.value} className={(state) => `openui-tab ${state.active ? 'oc-raised bg-[var(--surface-background)] dark:bg-surface-elevated text-foreground' : ''}`}>{item.trigger}</Tabs.Tab>
      ))}</Tabs.List>
      {props.items.map(({ props: item }, index) => (
        <Tabs.Panel key={item.value} value={item.value} className="openui-tab-panel">
          {renderOccurrences(renderNode, item.content, `items/${index}/content`)}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

export function ChamberAccordion({ props, renderNode }: Render<'Accordion'>) {
  const Official = openuiLibrary.components.Accordion.component;
  const paths = new Map<Parameters<typeof renderNode>[0], string>();
  // A shared DSL content array still has a distinct occurrence in each section.
  const items = props.items.map((item, index) => {
    const content = Array.isArray(item.props.content) ? [...item.props.content] : [item.props.content];
    paths.set(content, `items/${index}/content`);
    return { ...item, props: { ...item.props, content } };
  });
  return (
    <Official
      props={{ ...props, items }}
      renderNode={(value) => {
        const path = paths.get(value);
        return path ? renderOccurrences(renderNode, value, path) : renderNode(value);
      }}
    />
  );
}
