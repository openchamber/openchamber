import { z } from 'zod';
import { createLibrary, createParser, defineComponent, evaluateRoot, type ElementNode, type OpenUIError } from '@openuidev/lang-core';

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
  BarChart: z.object({ labels: z.array(z.string()), series: nodes, unit: z.string().optional() }),
  LineChart: z.object({ labels: z.array(z.string()), series: nodes, unit: z.string().optional() }),
  // null is a point with no data: the line breaks there, the bar is left out.
  Series: z.object({ name: z.string(), values: z.array(z.number().nullable()) }),
  Stat: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), delta: z.string().optional(), tone: tone.optional() }),
  Progress: z.object({ label: z.string(), value: z.number(), max: z.number().positive().optional() }),
  Choice: z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    multiple: z.boolean().optional(),
  }),
  Input: z.object({
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
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
  description: 'categories',
  props: blockProps.BarChart.extend({ series: z.array(Series.ref) }),
  component: null,
});
const LineChart = defineComponent({
  name: 'LineChart',
  description: 'trend',
  props: blockProps.LineChart.extend({ series: z.array(Series.ref) }),
  component: null,
});

const Choice = defineComponent({
  name: 'Choice',
  description: 'name keys the answer',
  props: blockProps.Choice,
  component: null,
});
const Input = defineComponent({
  name: 'Input',
  description: 'name keys the answer',
  props: blockProps.Input,
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
  Stat.ref, Progress.ref, Choice.ref, Input.ref, Button.ref,
]);

// The guidance names what nests where (guidance.ts); these unions only feed
// the parser's references, which it does not check against a parent.
const Row = defineComponent({
  name: 'Row',
  description: 'side by side, wraps',
  props: blockProps.Row.extend({ children: z.array(leaf) }),
  component: null,
});
const Card = defineComponent({
  name: 'Card',
  description: 'title "" for none',
  props: blockProps.Card.extend({ children: z.array(z.union([leaf, Row.ref])) }),
  component: null,
});
const Tab = defineComponent({
  name: 'Tab',
  description: '',
  props: blockProps.Tab.extend({ children: z.array(z.union([leaf, Card.ref, Row.ref])) }),
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
  props: blockProps.Stack.extend({ children: z.array(z.union([leaf, Card.ref, Row.ref, Tabs.ref])) }),
  component: null,
});

const components = [
  Stack, Row, Card, Tabs, Tab, Text, Badge, Callout, KeyValue, Table, Stat, Progress, Steps, BarChart, LineChart, Series,
  Choice, Input, Button,
];

export const uiBlockLibrary = createLibrary({ components, root: 'Stack' });

// Evaluation needs only the language's built-in functions, not the components.
const evaluationLibrary = createLibrary({ components: [] });

const parser = createParser(uiBlockLibrary.toJSONSchema(), 'Stack');

export type UiBlockParse =
  | { kind: 'empty' }
  | { kind: 'ready'; root: BlockValue }
  | { kind: 'invalid'; errors: string[] };

/**
 * Parses one block. While it streams, a partial tree renders as far as it has
 * arrived; once complete, any error makes the whole block invalid, so a
 * finished reply never shows a block with parts silently dropped.
 */
export function parseUiBlock(source: string, complete: boolean): UiBlockParse {
  const result = parser.parse(source);
  const errors = result.meta.errors.map((error) => (
    [error.component, error.path].filter(Boolean).join(' ') + `: ${error.message}`
  ));
  if (complete) {
    if (result.meta.incomplete) errors.push('The block ends in the middle of a statement');
    if (result.meta.unresolved.length) errors.push(`Undefined names: ${result.meta.unresolved.join(', ')}`);
    if (result.meta.orphaned.length) errors.push(`Defined but never used: ${result.meta.orphaned.join(', ')}`);
    if (Object.keys(result.stateDeclarations).length || result.queryStatements.length || result.mutationStatements.length) {
      errors.push('State, queries and mutations are not supported');
    }
    if (result.root?.typeName !== 'Stack') errors.push('The block needs root = Stack([...])');
    if (errors.length) return { kind: 'invalid', errors };
  }
  if (!result.root || result.root.typeName !== 'Stack') return { kind: 'empty' };
  if (!complete) {
    // Expressions such as "a" + "b" are evaluated by the language's own
    // built-ins once the block is complete; until then the block waits.
    return result.root.hasDynamicProps ? { kind: 'empty' } : { kind: 'ready', root: toBlockValue(result.root) };
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
  checkFinishedNode(tree, treeErrors);
  return treeErrors.length ? { kind: 'invalid', errors: treeErrors } : { kind: 'ready', root: tree };
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
 * value per label.
 */
function checkFinishedNode(value: BlockValue, errors: string[]): void {
  const node = blockNode.safeParse(value);
  const name = blockName.safeParse(node.data?.typeName);
  if (!node.success || !name.success) {
    errors.push('A component in the block is not one of the catalog');
    return;
  }
  if (node.data.partial) errors.push(`${name.data} is incomplete`);
  if (!blockProps[name.data].safeParse(node.data.props).success) errors.push(`${name.data} has arguments that do not match its signature`);
  const slots = childSlots.safeParse(node.data.props);
  if (!slots.success) {
    errors.push(`${name.data} has child slots that are not lists of components`);
    return;
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
  for (const child of [...slots.data.children ?? [], ...slots.data.tabs ?? [], ...slots.data.series ?? []]) checkFinishedNode(child, errors);
}

export type BlockField = { name: string; label: string };

/** Every node of a block, parent before children, in reading order. */
function eachNode(root: BlockValue, visit: (node: z.infer<typeof blockNode>) => void): void {
  const node = blockNode.safeParse(root);
  if (!node.success) return;
  visit(node.data);
  const slots = childSlots.safeParse(node.data.props);
  if (!slots.success) return;
  for (const child of [...slots.data.children ?? [], ...slots.data.tabs ?? []]) eachNode(child, visit);
}

/** The fields of a block, in reading order; their values make up an answer. */
export function blockFields(root: BlockValue): BlockField[] {
  const fields: BlockField[] = [];
  eachNode(root, (node) => {
    const field = node.typeName === 'Choice'
      ? blockProps.Choice.safeParse(node.props)
      : node.typeName === 'Input' ? blockProps.Input.safeParse(node.props) : null;
    if (field?.success && !fields.some((known) => known.name === field.data.name)) {
      fields.push({ name: field.data.name, label: field.data.label || field.data.name });
    }
  });
  return fields;
}

/**
 * The decisions a block asks for, in reading order: the buttons that share a
 * value make one decision, and buttons without a value one more.
 */
export function blockDecisions(root: BlockValue): string[] {
  const decisions: string[] = [];
  eachNode(root, (node) => {
    if (node.typeName !== 'Button') return;
    const button = blockProps.Button.safeParse(node.props);
    const decision = button.data?.value ?? '';
    if (button.success && !decisions.includes(decision)) decisions.push(decision);
  });
  return decisions;
}

