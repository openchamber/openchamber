import { defineComponent } from '@openuidev/lang-core';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { z } from 'zod/v4';
import { OPENUI_COMPONENT_NAMES, type OpenUICatalog } from './openuiSchema';
import { deriveOpenUIComponentSlots } from '../../../../../web/shared/openui/program.js';

const htmlViewProps = z.object({ html: z.string(), height: z.number().optional(), title: z.string().optional() });
const spacing = z.enum(['none', 'xs', 's', 'm', 'l', 'xl', '2xl']);
const dimension = z.union([z.number().min(0).max(200), z.enum(['auto', 'full'])]);
const layoutOptions = z.object({
  width: dimension.optional(),
  maxWidth: dimension.optional(),
  minWidth: dimension.optional(),
  grow: z.number().min(0).max(12).optional(),
  shrink: z.number().min(0).max(1).optional(),
  padding: spacing.optional(),
});
const imageOptions = z.object({
  aspectRatio: z.number().positive().max(20).optional(),
  fit: z.enum(['contain', 'cover']).optional(),
  caption: z.string().optional(),
  source: z.string().url().optional(),
});
const iconOptions = z.object({
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
  tone: z.enum(['default', 'muted', 'info', 'success', 'warning', 'danger']).optional(),
});
const chartOptions = z.object({
  layout: z.enum(['fit', 'scroll']).optional(),
  density: z.enum(['compact', 'default', 'spacious']).optional(),
  legend: z.boolean().optional(),
  grid: z.boolean().optional(),
  showYAxis: z.boolean().optional(),
  tickVariant: z.enum(['singleLine', 'multiLine', 'angled']).optional(),
  palette: z.array(z.number().int().min(1).max(6)).min(1).max(12).optional(),
});
const barOptions = chartOptions.extend({ orientation: z.enum(['vertical', 'horizontal']).optional() });
const pieOptions = chartOptions.pick({ legend: true, palette: true });
const htmlView = defineComponent({
  name: 'HtmlView',
  description: 'A sandboxed HTML document rendered by the host.',
  props: htmlViewProps,
  component: () => null,
});

// Grid slots contain visual nodes only. Nested grids can use Stack as their
// ordinary composition bridge; data constructors never become rendered slots.
const visualNames = [
  'Stack', 'Card', 'CardHeader', 'TextContent', 'Callout', 'Image', 'ImageGallery',
  'Carousel', 'Separator', 'Table', 'BarChart', 'LineChart', 'AreaChart', 'PieChart',
  'Form', 'Buttons', 'IconButton', 'Tabs', 'Accordion', 'Tag', 'TagBlock', 'Icon',
  'Label', 'Input', 'TextArea', 'Select', 'CheckBoxGroup', 'RadioGroup', 'SwitchGroup',
  'DatePicker', 'Slider', 'Chips', 'OptionCards',
] as const;
const visual = z.union([htmlView.ref, ...visualNames.map((name) => openuiLibrary.components[name].ref)]);
const gridItemProps = z.object({
  children: z.array(visual),
  colSpan: z.number().int().min(1).max(12).optional(),
  rowSpan: z.number().int().min(1).max(12).optional(),
});
const gridItem = defineComponent({
  name: 'GridItem',
  description: 'An optional spanning group inside Grid.',
  props: gridItemProps,
  component: () => null,
});
const gridProps = z.object({
  children: z.array(z.union([visual, gridItem.ref])),
  options: z.object({
    columns: z.union([
      z.number().int().min(1).max(12),
      z.array(z.number().positive().max(12)).min(1).max(12),
    ]).optional(),
    gap: spacing.optional(),
    minChildWidth: z.number().min(4).max(80).optional(),
  }).optional(),
});
const grid = defineComponent({
  name: 'Grid',
  description: 'Responsive grid. Numeric columns are equal tracks; arrays are fractional weights. minChildWidth is in rem.',
  props: gridProps,
  component: () => null,
});
const selected = new Set<string>(OPENUI_COMPONENT_NAMES);
const removedOpenUIComponents = Object.keys(openuiLibrary.components).filter((name) => !selected.has(name));

if (!openuiLibrary.extend) throw new Error('OpenUI library extensions are unavailable');
const optionSchemas = {
  Stack: layoutOptions,
  Card: layoutOptions,
  Image: imageOptions,
  BarChart: barOptions,
  LineChart: chartOptions,
  AreaChart: chartOptions,
  PieChart: pieOptions,
};
const openuiCatalogBase = openuiLibrary.extend({
  components: {
    remove: removedOpenUIComponents,
    override: [defineComponent({
      ...openuiLibrary.components.Icon,
      props: z.object({ name: z.string(), options: iconOptions.optional() }),
      description: 'An official Remix React icon by standard kebab-case name, including its line or fill suffix. Options control size and semantic tone.',
    }), ...Object.entries(optionSchemas).map(([name, options]) => defineComponent({
      ...openuiLibrary.components[name],
      props: openuiLibrary.components[name].props.extend({
        ...(name === 'Card' ? {
          children: z.array(z.union([
            openuiLibrary.components.Card.props.shape.children.element,
            openuiLibrary.components.Card.ref,
            openuiLibrary.components.Icon.ref,
          ])),
        } : {}),
        options: options.optional(),
      }),
    }))],
    add: [
      { component: htmlView, slots: ['Card.children'] },
      { component: grid, slots: ['Card.children', 'TabItem.content', 'AccordionItem.content', 'Carousel.children'] },
      gridItem,
    ],
  },
});

/** Data producer; server runtime reads the exported spec without loading React. */
export function deriveOpenUICatalog(): OpenUICatalog {
  const schema = openuiCatalogBase.toJSONSchema();
  return { schema, root: 'Stack', componentSlots: deriveOpenUIComponentSlots(schema), spec: openuiCatalogBase.toSpec() };
}
