import { z } from 'zod';
import { createLibrary, createParser, defineComponent, evaluateRoot, tokenize, type ElementNode, type OpenUIError, type ParseResult } from '@openuidev/lang-core';


export const tones = ['neutral', 'info', 'success', 'warning', 'error'] as const;
const tone = z.enum(tones);
const json = z.json();
export type BlockValue = z.infer<typeof json>;
const nodes = z.array(json);

const choiceOptionObject = z.object({ label: z.string(), description: z.string().optional() });
export const choiceOption = z.union([
  z.string().transform((label) => ({ label, description: undefined })),
  choiceOptionObject,
]);

export const blockProps = {
  Stack: z.object({ children: nodes }),
  Row: z.object({ children: nodes }),
  Card: z.object({ title: z.string(), children: nodes }),
  Tabs: z.object({ tabs: nodes }),
  Tab: z.object({ label: z.string(), children: nodes }),
  Text: z.object({ markdown: z.string() }),
  Badge: z.object({ label: z.string(), tone: tone.optional() }),
  Callout: z.object({ markdown: z.string(), tone: tone.optional(), title: z.string().optional() }),
  KeyValue: z.object({
    items: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) })),
  }),
  Table: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number()]))),
  }),
  Steps: z.object({
    items: z.array(z.object({
      title: z.string(),
      markdown: z.string().optional(),
      status: z.enum(['done', 'current', 'todo', 'blocked']).optional(),
    })),
    direction: z.enum(['column', 'row']).optional(),
  }),
  BarChart: z.object({ labels: z.array(z.string()), series: nodes, unit: z.string().optional(), whole: z.boolean().optional() }),
  LineChart: z.object({ labels: z.array(z.string()), series: nodes, unit: z.string().optional() }),
  Series: z.object({ name: z.string(), values: z.array(z.number().nullable()) }),
  Stat: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), delta: z.string().optional(), tone: tone.optional() }),
  Progress: z.object({ label: z.string(), value: z.number(), max: z.number().positive().optional() }),
  Choice: z.object({
    name: z.string(),
    options: z.array(z.union([z.string(), choiceOptionObject])),
    label: z.string().optional(),
    multiple: z.boolean().optional(),
  }),
  Input: z.object({
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
  DateInput: z.object({
    name: z.string(),
    label: z.string().optional(),
    time: z.boolean().optional(),
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).optional(),
  }),
  Slider: z.object({
    name: z.string(),
    min: z.number(),
    max: z.number(),
    label: z.string().optional(),
    step: z.number().positive().optional(),
    value: z.number().optional(),
    unit: z.string().optional(),
  }).refine((slider) => slider.max > slider.min),
  Details: z.object({ title: z.string(), children: nodes }),
  Button: z.object({ label: z.string(), variant: z.enum(['primary', 'secondary']).optional(), value: z.string().optional() }),
};

export type BlockName = keyof typeof blockProps;
// SAFETY: `Object.keys` of the literal `blockProps` lists exactly its keys, and there is at least one.
const blockNames = Object.keys(blockProps) as [BlockName, ...BlockName[]];
export const blockName = z.enum(blockNames);

export const blockNode = z.object({
  type: z.literal('element'),
  typeName: z.string(),
  partial: z.boolean().optional(),
  props: z.record(z.string(), json),
});

const Text = defineComponent({ name: 'Text', description: '', props: blockProps.Text, component: null });
const Badge = defineComponent({ name: 'Badge', description: '', props: blockProps.Badge, component: null });
const Callout = defineComponent({ name: 'Callout', description: '', props: blockProps.Callout, component: null });
const KeyValue = defineComponent({ name: 'KeyValue', description: '', props: blockProps.KeyValue, component: null });
const Table = defineComponent({ name: 'Table', description: '', props: blockProps.Table, component: null });
const Stat = defineComponent({ name: 'Stat', description: 'a key number; delta like "+12%"', props: blockProps.Stat, component: null });
const Progress = defineComponent({ name: 'Progress', description: 'max defaults to 100', props: blockProps.Progress, component: null });
const Steps = defineComponent({
  name: 'Steps',
  description: 'steps joined by a line; status marks execution progress',
  props: blockProps.Steps,
  component: null,
});
const Series = defineComponent({ name: 'Series', description: 'one value per label; null = no data', props: blockProps.Series, component: null });
const BarChart = defineComponent({
  name: 'BarChart',
  description: 'categories, not time; whole: one series of parts adding up to a whole, shows the total and shares',
  props: blockProps.BarChart.extend({ series: z.array(Series.ref) }),
  component: null,
});
const LineChart = defineComponent({
  name: 'LineChart',
  description: 'values over time; one series draws as an area',
  props: blockProps.LineChart.extend({ series: z.array(Series.ref) }),
  component: null,
});

const Choice = defineComponent({
  name: 'Choice',
  description: 'name keys the answer (the chosen labels); add a description where a label alone leaves its meaning unclear',
  props: blockProps.Choice,
  component: null,
});
const Input = defineComponent({
  name: 'Input',
  description: 'name keys the answer',
  props: blockProps.Input,
  component: null,
});
const DateInput = defineComponent({
  name: 'DateInput',
  description: 'name keys the answer: YYYY-MM-DD, with time YYYY-MM-DDTHH:mm; value prefills it',
  props: blockProps.DateInput,
  component: null,
});
const Slider = defineComponent({
  name: 'Slider',
  description: 'name keys the answer, a number; value is where it starts',
  props: blockProps.Slider,
  component: null,
});
const Button = defineComponent({
  name: 'Button',
  description: 'value = the item it decides; primary = your pick, one per decision',
  props: blockProps.Button,
  component: null,
});

const leaf = z.union([
  Text.ref, Badge.ref, Callout.ref, KeyValue.ref, Table.ref, Steps.ref, BarChart.ref, LineChart.ref,
  Stat.ref, Progress.ref, Choice.ref, Input.ref, DateInput.ref, Slider.ref, Button.ref,
]);

// external: https://github.com/thesysdev/openui/tree/main/packages/lang-core Child references do not enforce parent nesting; guidance defines it.
const Row = defineComponent({
  name: 'Row',
  description: 'side by side, wraps',
  props: blockProps.Row.extend({ children: z.array(leaf) }),
  component: null,
});
const Details = defineComponent({
  name: 'Details',
  description: 'collapsed until opened: detail not every reader needs',
  props: blockProps.Details.extend({ children: z.array(z.union([leaf, Row.ref])) }),
  component: null,
});
const Card = defineComponent({
  name: 'Card',
  description: 'title: inline Markdown, "" for none',
  props: blockProps.Card.extend({ children: z.array(z.union([leaf, Row.ref, Details.ref])) }),
  component: null,
});
const Tab = defineComponent({
  name: 'Tab',
  description: '',
  props: blockProps.Tab.extend({ children: z.array(z.union([leaf, Card.ref, Row.ref, Details.ref])) }),
  component: null,
});
const Tabs = defineComponent({
  name: 'Tabs',
  description: '',
  props: blockProps.Tabs.extend({ tabs: z.array(Tab.ref) }),
  component: null,
});
const Stack = defineComponent({
  name: 'Stack',
  description: 'the root',
  props: blockProps.Stack.extend({ children: z.array(z.union([leaf, Card.ref, Row.ref, Tabs.ref, Details.ref])) }),
  component: null,
});

const components = [
  Stack, Row, Card, Tabs, Tab, Details, Text, Badge, Callout, KeyValue, Table, Stat, Progress, Steps, BarChart, LineChart, Series,
  Choice, Input, DateInput, Slider, Button,
];

export const uiBlockLibrary = createLibrary({ components, root: 'Stack' });

const evaluationLibrary = createLibrary({ components: [] });

const parser = createParser(uiBlockLibrary.toJSONSchema(), 'Stack');

export type ExtensionBlock = {
  guestId: string;
  name: string;
  description: string;
  args: string[];
  entry: string;
  height?: number;
  answers?: boolean;
};

export type ExtensionBlocks = ReadonlyMap<string, ExtensionBlock>;
export const NO_EXTENSION_BLOCKS: ExtensionBlocks = new Map();

export const collectExtensionBlocks = (blocks: readonly ExtensionBlock[]): ExtensionBlocks => {
  const collected = new Map<string, ExtensionBlock>();
  for (const block of blocks) {
    if (block.name in blockProps || collected.has(block.name)) {
      console.warn(`[ui-blocks] ${block.guestId}: the block "${block.name}" is already taken and was left out`);
      continue;
    }
    collected.set(block.name, block);
  }
  return collected.size > 0 ? collected : NO_EXTENSION_BLOCKS;
};

const extensionBlockProps = (block: ExtensionBlock) => z.object(Object.fromEntries(block.args.map((arg) => [arg, z.string().optional()])));

let extendedParser: { blocks: ExtensionBlocks; parser: typeof parser } | null = null;

const parserFor = (blocks: ExtensionBlocks): typeof parser => {
  if (blocks.size === 0) return parser;
  if (extendedParser?.blocks !== blocks) {
    const extra = [...blocks.values()].map((block) => defineComponent({
      name: block.name,
      description: block.description,
      props: extensionBlockProps(block),
      component: null,
    }));
    extendedParser = { blocks, parser: createParser(createLibrary({ components: [...components, ...extra], root: 'Stack' }).toJSONSchema(), 'Stack') };
  }
  return extendedParser.parser;
};

export type UiBlockParse =
  | { kind: 'empty' }
  | { kind: 'ready'; root: BlockValue; dropped: string[] }
  | { kind: 'invalid'; errors: string[] };

// external: https://github.com/thesysdev/openui/tree/main/packages/lang-core Broken parents lose their children in the parsed tree, so salvage checks the source for fields.
const asksSomething = /\b(?:Choice|Input|DateInput|Slider|Button)\s*\(/;

const canDropParts = (source: string, kept: BlockValue): boolean => (
  !asksSomething.test(source) && (childSlots.safeParse(blockNode.safeParse(kept).data?.props).data?.children?.length ?? 0) > 0
);

export function parseUiBlock(source: string, complete: boolean, salvage = false, extensions: ExtensionBlocks = NO_EXTENSION_BLOCKS): UiBlockParse {
  const result = parserFor(extensions).parse(source);
  const errors = result.meta.errors
    .filter((error) => !(error.component === 'Details' && error.path === '/children' && error.code === 'missing-required'))
    .map((error) => [error.component, error.path].filter(Boolean).join(' ') + `: ${error.message}`);
  const namedError = complete ? namedArgumentError(source, result.meta) : null;
  if (complete) {
    if (result.meta.unresolved.length) errors.push(`Undefined names: ${result.meta.unresolved.join(', ')}`);
    if (result.meta.orphaned.length) errors.push(`Defined but never used: ${result.meta.orphaned.join(', ')}`);
    const unusable: string[] = [];
    if (result.meta.incomplete) unusable.push('The block ends in the middle of a statement');
    if (Object.keys(result.stateDeclarations).length || result.queryStatements.length || result.mutationStatements.length) {
      unusable.push('State, queries and mutations are not supported');
    }
    if (result.root?.typeName !== 'Stack') unusable.push('The block needs root = Stack([...])');
    if (namedError) errors.splice(0, errors.length, namedError);
    if (unusable.length || (errors.length && !salvage)) return { kind: 'invalid', errors: [...errors, ...unusable] };
  }
  if (!result.root || result.root.typeName !== 'Stack') return { kind: 'empty' };
  if (!complete) {
    return result.root.hasDynamicProps ? { kind: 'empty' } : { kind: 'ready', root: toBlockValue(result.root), dropped: [] };
  }
  let root = result.root;
  if (root.hasDynamicProps) {
    const evaluationErrors: OpenUIError[] = [];
    const evaluated = evaluateRoot(result, {
      library: evaluationLibrary,
      store: null,
      errors: evaluationErrors,
      ctx: { getState: () => undefined, resolveRef: () => undefined },
    });
    if (evaluationErrors.length || !evaluated) return { kind: 'invalid', errors: ['An expression in the block could not be evaluated'] };
    root = evaluated;
  }
  const tree = toBlockValue(root);
  const treeErrors: string[] = [];
  const kept = soundNode(tree, treeErrors, extensions);
  const problems = namedError ? errors : [...errors, ...treeErrors];
  if (!problems.length) return { kind: 'ready', root: tree, dropped: [] };
  // external: https://github.com/thesysdev/openui/tree/main/packages/lang-core Expressions over broken names can evaluate to invented values, so expression blocks cannot be salvaged.
  if (!salvage || !kept || result.root.hasDynamicProps || !canDropParts(source, kept)) return { kind: 'invalid', errors: problems };
  return { kind: 'ready', root: kept, dropped: problems };
}

// external: https://github.com/thesysdev/openui/tree/main/packages/lang-core Token kinds are not exported; derive them with the tokenizer.
const tokenKind = (text: string) => tokenize(text)[0].t;
const NEWLINE = tokenKind('\n');
const CALL_OPEN = tokenKind('(');
const COMMA = tokenKind(',');
const COLON = tokenKind(':');
const IDENTIFIER = tokenKind('name');
const ARRAY_OPEN = tokenKind('[');
const OBJECT_OPEN = tokenKind('{');
const OPENERS = new Set([CALL_OPEN, ARRAY_OPEN, OBJECT_OPEN]);
const OPENER_OF = new Map([[tokenKind(')'), CALL_OPEN], [tokenKind(']'), ARRAY_OPEN], [tokenKind('}'), OBJECT_OPEN]]);

function namedArguments(source: string): string[] {
  const tokens = tokenize(source).filter((token) => token.t !== NEWLINE);
  const open: (typeof CALL_OPEN)[] = [];
  const names = new Set<string>();
  tokens.forEach((token, index) => {
    if (OPENERS.has(token.t)) open.push(token.t);
    else if (OPENER_OF.has(token.t)) {
      if (OPENER_OF.get(token.t) === open.at(-1)) open.pop();
    } else if (token.t === COLON && open.at(-1) === CALL_OPEN && tokens[index - 1]?.t === IDENTIFIER) {
      const before = tokens[index - 2]?.t;
      if (before === CALL_OPEN || before === COMMA) names.add(String(tokens[index - 1].v));
    }
  });
  return [...names];
}

function namedArgumentError(source: string, meta: ParseResult['meta']): string | null {
  const excess = meta.errors.some((error) => error.code === 'excess-args');
  if (!excess && !meta.unresolved.length) return null;
  const named = namedArguments(source);
  if (!excess && !named.some((name) => meta.unresolved.includes(name))) return null;
  return named.length ? `Named arguments aren't supported: pass ${named.join(', ')} by position` : null;
}

function toBlockValue(root: ElementNode): BlockValue {
  return json.parse(JSON.parse(JSON.stringify(root)));
}

const childSlots = z.object({ children: nodes.optional(), tabs: nodes.optional(), series: nodes.optional() });
const chart = z.object({ labels: z.array(z.string()), series: nodes });

function soundNode(value: BlockValue, errors: string[], extensions: ExtensionBlocks): BlockValue | null {
  const node = blockNode.safeParse(value);
  const extension = node.data ? extensions.get(node.data.typeName) : undefined;
  if (extension) {
    if (node.data?.partial) errors.push(`${extension.name} is incomplete`);
    if (!extensionBlockProps(extension).safeParse(node.data?.props).success) errors.push(`${extension.name} has arguments that do not match its signature`);
    return node.data?.partial ? null : value;
  }
  const name = blockName.safeParse(node.data?.typeName);
  if (!node.success || !name.success) {
    errors.push('A component in the block is not one of the catalog');
    return null;
  }
  const errorsBefore = errors.length;
  if (node.data.partial) errors.push(`${name.data} is incomplete`);
  if (!blockProps[name.data].safeParse(node.data.props).success) errors.push(`${name.data} has arguments that do not match its signature`);
  const slots = childSlots.safeParse(node.data.props);
  if (!slots.success) {
    errors.push(`${name.data} has child slots that are not lists of components`);
    return null;
  }
  const chartProps = name.data === 'BarChart' || name.data === 'LineChart' ? chart.safeParse(node.data.props) : null;
  if (chartProps?.success) {
    for (const series of chartProps.data.series) {
      const count = blockProps.Series.safeParse(blockNode.safeParse(series).data?.props).data?.values.length ?? 0;
      if (count !== chartProps.data.labels.length) {
        errors.push(`${name.data}: a series has ${count} values for ${chartProps.data.labels.length} labels`);
      }
    }
  }
  const broken = errors.length > errorsBefore;
  const props = { ...node.data.props };
  for (const [slot, children] of Object.entries(slots.data)) {
    props[slot] = (children ?? []).flatMap((child) => soundNode(child, errors, extensions) ?? []);
  }
  return broken ? null : { ...node.data, props };
}

export type BlockField = { name: string; label: string; initial?: string };

function eachNode(root: BlockValue, visit: (node: z.infer<typeof blockNode>, cardTitle: string) => void, cardTitle = ''): void {
  const node = blockNode.safeParse(root);
  if (!node.success) return;
  const title = node.data.typeName === 'Card' ? blockProps.Card.safeParse(node.data.props).data?.title ?? '' : cardTitle;
  visit(node.data, title);
  const slots = childSlots.safeParse(node.data.props);
  if (!slots.success) return;
  for (const child of [...slots.data.children ?? [], ...slots.data.tabs ?? []]) eachNode(child, visit, title);
}

const fieldOf = (node: z.infer<typeof blockNode>): BlockField | null => {
  const named = (data: { name: string; label?: string }, initial?: string): BlockField => (
    initial === undefined ? { name: data.name, label: data.label || data.name } : { name: data.name, label: data.label || data.name, initial }
  );
  switch (node.typeName) {
    case 'Choice': { const field = blockProps.Choice.safeParse(node.props); return field.success ? named(field.data) : null; }
    case 'Input': { const field = blockProps.Input.safeParse(node.props); return field.success ? named(field.data) : null; }
    case 'DateInput': { const field = blockProps.DateInput.safeParse(node.props); return field.success ? named(field.data, dateStart(field.data)) : null; }
    case 'Slider': {
      const field = blockProps.Slider.safeParse(node.props);
      return field.success ? named(field.data, String(sliderStart(field.data))) : null;
    }
    default: return null;
  }
};

export const DEFAULT_TIME = '09:00';

const dateStart = (field: z.infer<typeof blockProps.DateInput>): string | undefined => {
  if (!field.value) return undefined;
  const date = field.value.slice(0, 10);
  return field.time ? `${date}T${field.value.slice(11, 16) || DEFAULT_TIME}` : date;
};

export function sliderStart(slider: z.infer<typeof blockProps.Slider>): number {
  const step = slider.step ?? 1;
  const wanted = slider.value ?? slider.min + (slider.max - slider.min) / 2;
  const lastStep = Math.floor((slider.max - slider.min) / step);
  const steps = Math.min(lastStep, Math.max(0, Math.round((wanted - slider.min) / step)));
  return Number((slider.min + steps * step).toFixed(10));
}

export function blockFields(root: BlockValue): BlockField[] {
  const fields: BlockField[] = [];
  eachNode(root, (node) => {
    const field = fieldOf(node);
    if (field && !fields.some((known) => known.name === field.name)) fields.push(field);
  });
  return fields;
}

export function blockQuestions(root: BlockValue): string[] {
  const questions: string[] = [];
  const seen = new Set<string>();
  eachNode(root, (node, cardTitle) => {
    const field = fieldOf(node);
    if (!field || seen.has(field.name)) return;
    seen.add(field.name);
    questions.push(field.label !== field.name ? field.label : cardTitle.trim() || field.name);
  });
  return questions;
}

export function answeringFrame(root: BlockValue, extensions: ExtensionBlocks): string | null {
  let found: string | null = null;
  eachNode(root, (node) => {
    if (!found && extensions.get(node.typeName)?.answers) found = node.typeName;
  });
  return found;
}

export type BlockPath = string;
export const blockPath = (parent: BlockPath, index: number): BlockPath => (parent ? `${parent}/${index}` : String(index));

const isButtonRun = (value: BlockValue) => {
  const node = blockNode.safeParse(value);
  if (!node.success) return false;
  if (node.data.typeName === 'Button') return true;
  return node.data.typeName === 'Row'
    && (childSlots.safeParse(node.data.props).data?.children ?? []).some((child) => blockNode.safeParse(child).data?.typeName === 'Button');
};

export function noteSlot(root: BlockValue): { parent: BlockPath; index: number } | null {
  let found: { parent: BlockPath; index: number } | null = null;
  const walk = (value: BlockValue, path: BlockPath) => {
    const children = childSlots.safeParse(blockNode.safeParse(value).data?.props).data?.children;
    if (!children) return;
    children.forEach((child, index) => {
      if (isButtonRun(child)) {
        if (index === 0 || !isButtonRun(children[index - 1])) found = { parent: path, index };
        return;
      }
      walk(child, blockPath(path, index));
    });
  };
  walk(root, '');
  return found;
}

export function decisionTitles(root: BlockValue): ReadonlySet<string> {
  const counts = new Map<string, number>();
  eachNode(root, (node) => {
    const title = node.typeName === 'Card' ? blockProps.Card.safeParse(node.props).data?.title : undefined;
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  });
  return new Set([...counts].flatMap(([title, count]) => (count === 1 ? [title] : [])));
}

export const decisionOf = (titles: ReadonlySet<string>, cardTitle: string, buttonValue: string | undefined): string => (
  titles.has(cardTitle) ? cardTitle : buttonValue ?? ''
);

const decisionsIn = (root: BlockValue, titles: ReadonlySet<string>) => {
  const decisions: string[] = [];
  let fields = false;
  eachNode(root, (node, cardTitle) => {
    if (fieldOf(node)) fields = true;
    const button = node.typeName === 'Button' ? blockProps.Button.safeParse(node.props) : null;
    const decision = button?.success ? decisionOf(titles, cardTitle, button.data.value) : null;
    if (decision !== null && !decisions.includes(decision)) decisions.push(decision);
  });
  return { decisions, fields };
};

export function cardDecision(card: BlockValue, titles: ReadonlySet<string>): string | null {
  const { decisions, fields } = decisionsIn(card, titles);
  return !fields && decisions.length === 1 ? decisions[0] : null;
}

export const blockDecisions = (root: BlockValue): string[] => decisionsIn(root, decisionTitles(root)).decisions;
