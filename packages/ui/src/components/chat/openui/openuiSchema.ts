import type { LibraryJSONSchema, LibrarySpec } from '@openuidev/lang-core';
import type { OpenUIComponentSlot } from '../../../../../web/shared/openui/program.js';

export const OPENUI_COMPONENT_NAMES = [
  'Grid', 'GridItem', 'ImageGallery', 'Carousel', 'Separator',
  'Card', 'CardHeader', 'TextContent', 'Callout', 'Image', 'Table', 'Col', 'BarChart', 'LineChart', 'AreaChart', 'Series', 'PieChart', 'Form', 'FormControl', 'Label', 'Input', 'TextArea', 'Select', 'SelectItem', 'DatePicker', 'Slider', 'CheckBoxGroup', 'CheckBoxItem', 'RadioGroup', 'RadioItem', 'SwitchGroup', 'SwitchItem', 'ChipItem', 'Chips', 'OptionCard', 'OptionCards', 'Button', 'Buttons', 'IconButton', 'Stack', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem', 'TagBlock', 'Tag', 'Icon', 'HtmlView',
] as const;

export const OPENUI_RESIDENT_COMPONENT_NAMES = [
  'Stack', 'Card', 'CardHeader', 'TextContent', 'Callout', 'Grid', 'GridItem', 'Separator', 'TagBlock', 'Tag', 'Icon',
  'Image', 'ImageGallery', 'Label', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem', 'Carousel',
] as const;

export interface OpenUICatalog {
  schema: LibraryJSONSchema;
  root: 'Stack';
  componentSlots: readonly OpenUIComponentSlot[];
  spec: LibrarySpec;
}
