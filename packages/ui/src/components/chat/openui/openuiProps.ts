import type { ActionPlan, ElementNode, SubComponentOf } from '@openuidev/react-lang';
import type { IconButtonProps } from '@openuidev/react-ui';
import type { z } from 'zod/v4';
import type { htmlViewProps, layoutOptions, imageOptions, iconOptions, chartOptions, barOptions, pieOptions, gridProps, gridItemProps } from './openuiCatalog.schema';

// The public genui-lib entry erases its component props. These types describe
// only the values read by Chamber adapters; the official schemas own the DSL.
interface Rules {
  required?: boolean;
  email?: boolean;
  url?: boolean;
  numeric?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

interface Field<T> {
  name: string;
  rules?: Rules;
  value?: T;
}

interface Layout {
  direction?: 'row' | 'column';
  gap?: 'none' | 'xs' | 's' | 'm' | 'l' | 'xl' | '2xl';
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
  wrap?: boolean;
}

interface Choice {
  name: string;
  type: 'single' | 'multiple';
  rules?: Rules;
  defaultValue?: string | string[];
}

interface Chart {
  labels: string[];
  series: SubComponentOf<{ category: string; values: number[] }>[];
  xLabel?: string;
  yLabel?: string;
  height?: number;
  options?: z.infer<typeof chartOptions>;
}

interface Section {
  items: SubComponentOf<{ value: string; trigger: string; content: unknown[] }>[];
}

export interface OpenUIProps {
  Grid: z.infer<typeof gridProps>;
  GridItem: z.infer<typeof gridItemProps>;
  ImageGallery: { images: { src: string; alt?: string; details?: string }[] };
  Carousel: { children: unknown[][]; variant?: 'card' | 'sunk' };
  HtmlView: z.infer<typeof htmlViewProps>;
  Input: Field<string> & {
    placeholder?: string;
    type?: 'text' | 'email' | 'password' | 'number' | 'url';
  };
  TextArea: Field<string> & { placeholder?: string; rows?: number };
  Button: {
    label: string;
    action?: ActionPlan;
    variant?: 'primary' | 'secondary' | 'tertiary';
    type?: 'normal' | 'destructive';
    size?: 'extra-small' | 'small' | 'medium' | 'large';
  };
  IconButton: Omit<OpenUIProps['Button'], 'label' | 'type'> & Pick<IconButtonProps, 'shape'> & {
    name: string;
    icon: SubComponentOf<OpenUIProps['Icon']>;
  };
  TextContent: { text: string; size?: 'small' | 'default' | 'large' | 'small-heavy' | 'large-heavy' };
  Callout: { variant: 'info' | 'warning' | 'error' | 'success' | 'neutral'; title: string; description: string; visible?: boolean };
  Form: { name: string; buttons: ElementNode; fields: ElementNode[] };
  FormControl: { label: string; input: SubComponentOf<{ name: string; rules?: Rules }>; hint?: string };
  Select: Field<string> & { items: SubComponentOf<{ value: string; label: string }>[]; placeholder?: string; size?: 'small' | 'medium' | 'large' };
  CheckBoxGroup: Field<{ [name: string]: boolean }> & {
    items: SubComponentOf<{ name: string; label: string; description: string; defaultChecked?: boolean }>[];
  };
  SwitchGroup: {
    name: string;
    value?: { [name: string]: boolean };
    variant?: 'clear' | 'card' | 'sunk';
    items: SubComponentOf<{ name: string; label?: string; description?: string; defaultChecked?: boolean }>[];
  };
  Icon: { name: string; options?: z.infer<typeof iconOptions> };
  Tag: { text: string; icon?: SubComponentOf<OpenUIProps['Icon']>; size?: 'sm' | 'md' | 'lg'; variant?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' };
  Image: { alt: string; src?: string; options?: z.infer<typeof imageOptions> };
  Chips: Choice & { items: SubComponentOf<{ value: string; label: string; icon?: SubComponentOf<OpenUIProps['Icon']>; disabled?: boolean }>[] };
  OptionCards: Choice & { items: SubComponentOf<{ value: string; title: string; subtitle?: string; topContent?: SubComponentOf<OpenUIProps['Icon'] | OpenUIProps['Image']>; disabled?: boolean }>[] };
  RadioGroup: Field<string> & { items: SubComponentOf<{ value: string; label: string; description: string }>[]; defaultValue?: string };
  DatePicker: Field<unknown> & { mode?: 'single' | 'range' };
  Slider: Field<number[]> & { variant: 'continuous' | 'discrete'; min: number; max: number; step?: number; defaultValue?: number[]; label?: string };
  Table: { columns: SubComponentOf<{ label: string; data: unknown }>[] };
  BarChart: Chart & { variant?: 'grouped' | 'stacked'; options?: z.infer<typeof barOptions> };
  LineChart: Chart & { variant?: 'linear' | 'natural' | 'step' };
  AreaChart: OpenUIProps['LineChart'];
  PieChart: { labels: string[]; values: number[]; variant?: 'pie' | 'donut'; appearance?: 'circular' | 'semiCircular'; options?: z.infer<typeof pieOptions> };
  Stack: Layout & { children: unknown[]; options?: z.infer<typeof layoutOptions> };
  Card: Layout & { children: unknown[]; variant?: 'card' | 'sunk' | 'clear'; options?: z.infer<typeof layoutOptions> };
  Tabs: Section;
  Accordion: Section;
}
