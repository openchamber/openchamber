import { z } from 'zod';
import { createLibrary, createParser, defineComponent, evaluateRoot, tokenize, type ElementNode, type OpenUIError, type ParseResult } from '@openuidev/lang-core';

/**
 * The fixed component catalog an agent writes UI blocks against.
 *
 * `blockProps` is what the renderer and the finished-block check read: each
 * component's props, with child slots as lists of nodes that their own entry
 * checks. The `lang-core` definitions below reuse those schemas and replace
 * the child slots with typed references, which is what the parser checks and
 * what the agent's signatures print.
 */

export const tones = ['neutral', 'info', 'success', 'warning', 'error'] as const;
const tone = z.enum(tones);
const json = z.json();
export type BlockValue = z.infer<typeof json>;
const nodes = z.array(json);

const choiceOptionObject = z.object({ label: z.string(), description: z.string().optional() });
/** A Choice option read as its label and description, whichever way the agent wrote it. */
export const choiceOption = z.union([
  z.string().transform((label) => ({ label, description: undefined })),
  choiceOptionObject,
]);

export const blockProps = {
  Stack: z.object({ children: nodes }),
  Row: z.object({ children: nodes }),
  // The title comes first and is required: a skipped first argument cannot
  // be written positionally, so an empty title stands for none.
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
  // null is a point with no data: the line breaks there, the bar is left out.
  Series: z.object({ name: z.string(), values: z.array(z.number().nullable()) }),
  Stat: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), delta: z.string().optional(), tone: tone.optional() }),
  Progress: z.object({ label: z.string(), value: z.number(), max: z.number().positive().optional() }),
  Choice: z.object({
    name: z.string(),
    // An option is its label, or a label with a line saying what choosing it means.
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
  // A local date, with a time when asked: YYYY-MM-DD or YYYY-MM-DDTHH:mm.
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

/** A node as the parser emits it; its props are read through `blockProps`. */
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
  description: 'flow joined by arrows',
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

// The guidance names what nests where (guidance.ts); these unions only feed
// the parser's references, which it does not check against a parent.
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

// Evaluation needs only the language's built-in functions, not the components.
const evaluationLibrary = createLibrary({ components: [] });

const parser = createParser(uiBlockLibrary.toJSONSchema(), 'Stack');

/** A component an active extension adds; its own page draws it (`ExtensionBlockFrame`). */
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

/** The active extensions' components by name. The catalog's own names stay the catalog's, and the first extension keeps a shared name. */
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

/**
 * The parser for the current set, built once per set. Extensions change
 * rarely and only on a catalog change, while every keystroke of a streaming
 * block parses again.
 */
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
  /** `dropped` says what a salvaged block lost; it is empty for a whole block. */
  | { kind: 'ready'; root: BlockValue; dropped: string[] }
  | { kind: 'invalid'; errors: string[] };

// Read off the source: the parser's tree has already lost whatever sat under a
// broken parent. The word in a string only costs that block its salvage.
const asksSomething = /\b(?:Choice|Input|DateInput|Slider|Button)\s*\(/;

/**
 * Whether a block may draw without its broken parts: it shows something and
 * asks nothing. A form that lost an option or a button would take an answer
 * to a different question.
 */
const canDropParts = (source: string, kept: BlockValue): boolean => (
  !asksSomething.test(source) && (childSlots.safeParse(blockNode.safeParse(kept).data?.props).data?.children?.length ?? 0) > 0
);

/**
 * Parses one block. While it streams, a partial tree renders as far as it has
 * arrived. Once complete, any error makes the block invalid; with `salvage`, a
 * block that only shows things draws the parts that are sound and names the
 * rest in `dropped`. A block cut short or written in a shape the chat does not
 * support stays invalid either way.
 */
export function parseUiBlock(source: string, complete: boolean, salvage = false, extensions: ExtensionBlocks = NO_EXTENSION_BLOCKS): UiBlockParse {
  const result = parserFor(extensions).parse(source);
  // A fold with nothing inside loses nothing by not drawing, and the parser
  // has already left it out of the tree.
  const errors = result.meta.errors
    .filter((error) => !(error.component === 'Details' && error.path === '/children' && error.code === 'missing-required'))
    .map((error) => [error.component, error.path].filter(Boolean).join(' ') + `: ${error.message}`);
  // A key shifts every argument after it, so the other errors of such a block mislead.
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
    // Expressions such as "a" + "b" are evaluated by the language's own
    // built-ins once the block is complete; until then the block waits.
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
  // An expression over a broken name evaluates to a made-up value, so a block
  // with expressions is not salvaged.
  if (!salvage || !kept || result.root.hasDynamicProps || !canDropParts(source, kept)) return { kind: 'invalid', errors: problems };
  return { kind: 'ready', root: kept, dropped: problems };
}

// The library does not export its token kinds, so they are read from its own tokenizer.
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

/**
 * The keys written as `key: value` where a call takes an argument. A key of an
 * object literal sits inside braces, and a ternary's `:` follows an expression
 * that starts after its `?`, so neither counts.
 */
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

/**
 * The error for a block that writes named arguments. The scan reads text the
 * parser skips, such as comments, so the parser has to show the shift too: an
 * excess argument, or a key it took for an undefined name.
 */
function namedArgumentError(source: string, meta: ParseResult['meta']): string | null {
  const excess = meta.errors.some((error) => error.code === 'excess-args');
  if (!excess && !meta.unresolved.length) return null;
  const named = namedArguments(source);
  if (!excess && !named.some((name) => meta.unresolved.includes(name))) return null;
  return named.length ? `Named arguments aren't supported: pass ${named.join(', ')} by position` : null;
}

/** The parser's tree as plain JSON: absent optional fields drop out. */
function toBlockValue(root: ElementNode): BlockValue {
  return json.parse(JSON.parse(JSON.stringify(root)));
}

const childSlots = z.object({ children: nodes.optional(), tabs: nodes.optional(), series: nodes.optional() });
const chart = z.object({ labels: z.array(z.string()), series: nodes });

/**
 * What the parser lets through but a finished block must not show: a node it
 * kept as partial, a node whose props do not match its component (an element
 * written as an object literal), and a chart whose series do not have one
 * value per label. Returns the node without such parts, null when the node
 * itself is one, and lists every one found in `errors`.
 */
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

/** A field of a block; `initial` is the value it starts with, which an answer carries unless the user changes it. */
export type BlockField = { name: string; label: string; initial?: string };

/** Every node of a block, parent before children, in reading order, with the title of the card it sits in. */
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

/** The time a date field shows before the user picks one. */
export const DEFAULT_TIME = '09:00';

/** What a prefilled date field holds, in the shape its answer takes: a time only when the field asks for one. */
const dateStart = (field: z.infer<typeof blockProps.DateInput>): string | undefined => {
  if (!field.value) return undefined;
  const date = field.value.slice(0, 10);
  return field.time ? `${date}T${field.value.slice(11, 16) || DEFAULT_TIME}` : date;
};

/**
 * Where a slider starts: its value, else the middle, on the nearest step the
 * slider can stand on, so the label and the answer match the thumb.
 */
export function sliderStart(slider: z.infer<typeof blockProps.Slider>): number {
  const step = slider.step ?? 1;
  const wanted = slider.value ?? slider.min + (slider.max - slider.min) / 2;
  const lastStep = Math.floor((slider.max - slider.min) / step);
  const steps = Math.min(lastStep, Math.max(0, Math.round((wanted - slider.min) / step)));
  // Rounded to clear float noise such as 0.30000000000000004.
  return Number((slider.min + steps * step).toFixed(10));
}

/** The fields of a block, in reading order; their values make up an answer. */
export function blockFields(root: BlockValue): BlockField[] {
  const fields: BlockField[] = [];
  eachNode(root, (node) => {
    const field = fieldOf(node);
    if (field && !fields.some((known) => known.name === field.name)) fields.push(field);
  });
  return fields;
}

/** The first extension component in the block whose frame takes the answer itself. */
export function answeringFrame(root: BlockValue, extensions: ExtensionBlocks): string | null {
  let found: string | null = null;
  eachNode(root, (node) => {
    if (!found && extensions.get(node.typeName)?.answers) found = node.typeName;
  });
  return found;
}

/** Where a node's children sit: the child indexes that lead to it from the root. */
export type BlockPath = string;
export const blockPath = (parent: BlockPath, index: number): BlockPath => (parent ? `${parent}/${index}` : String(index));

const isButtonRun = (value: BlockValue) => {
  const node = blockNode.safeParse(value);
  if (!node.success) return false;
  if (node.data.typeName === 'Button') return true;
  // A row of buttons moves as one; the note never lands inside a row.
  return node.data.typeName === 'Row'
    && (childSlots.safeParse(node.data.props).data?.children ?? []).some((child) => blockNode.safeParse(child).data?.typeName === 'Button');
};

/**
 * Where a waiting form's note goes: before the last run of buttons in reading
 * order, outside tabs, so the user writes it before pressing one. `parent` is
 * the path of the node whose children hold the run, `index` the run's first
 * child. null when the block has no such run.
 */
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

/**
 * Titles of the cards that name their decision: those no other card in the
 * block shares. A card is one item, so all its buttons are one decision named
 * by its title, whatever values they carry: agents often give each option its
 * own value. Two cards with one title would merge, so they fall back to values.
 */
export function decisionTitles(root: BlockValue): ReadonlySet<string> {
  const counts = new Map<string, number>();
  eachNode(root, (node) => {
    const title = node.typeName === 'Card' ? blockProps.Card.safeParse(node.props).data?.title : undefined;
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  });
  return new Set([...counts].flatMap(([title, count]) => (count === 1 ? [title] : [])));
}

/**
 * Which decision a button of a reply answers: its card's title when that
 * names a decision (`decisionTitles`), else its value. Buttons that share a
 * value are one decision.
 */
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

/**
 * The one decision a card in a reply asks for, when it holds no fields. Once
 * answered the card folds to one line; a card with fields stays open so they
 * stay readable. null for a card with no buttons, several decisions, or fields.
 */
export function cardDecision(card: BlockValue, titles: ReadonlySet<string>): string | null {
  const { decisions, fields } = decisionsIn(card, titles);
  return !fields && decisions.length === 1 ? decisions[0] : null;
}

/** The decisions a reply's block asks for, in reading order (`decisionOf`). */
export const blockDecisions = (root: BlockValue): string[] => decisionsIn(root, decisionTitles(root)).decisions;
