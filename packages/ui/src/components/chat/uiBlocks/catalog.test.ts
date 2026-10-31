import { describe, expect, test } from 'bun:test';
import { blockDecisions, blockNode, blockProps, parseUiBlock, type BlockValue } from './catalog';

const program = `root = Stack([note, flow])
note = Callout("Routers rewrite **MAC** addresses", "info")
flow = Steps([{title: "App"}, {title: "TCP", status: "done"}], "row")
`;

const childrenOf = (root: BlockValue) => blockProps.Stack.parse(blockNode.parse(root).props).children.map((child) => blockNode.parse(child));

describe('parseUiBlock', () => {
  test('a complete program yields its tree', () => {
    const parsed = parseUiBlock(program, true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(childrenOf(parsed.root).map((child) => child.typeName)).toEqual(['Callout', 'Steps']);
  });

  test('a streaming prefix renders what has arrived', () => {
    expect(parseUiBlock(program.slice(0, 70), false).kind).toBe('ready');
  });

  test('a finished block with a wrong prop is invalid, with the parser message', () => {
    const parsed = parseUiBlock('root = Stack([Text(1)])', true);
    if (parsed.kind !== 'invalid') throw new Error(`expected invalid, got ${parsed.kind}`);
    expect(parsed.errors.join('\n')).toContain('expects string');
  });

  test('a finished block that references an undefined name is invalid', () => {
    expect(parseUiBlock('root = Stack([missing])', true).kind).toBe('invalid');
  });

  test('built-in expressions are evaluated once the block is complete', () => {
    const parsed = parseUiBlock('root = Stack([Text("a" + "b")])', true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    const [text] = childrenOf(parsed.root);
    expect(blockProps.Text.parse(text.props).markdown).toBe('ab');
  });

  test('a block without a Stack root is invalid once complete', () => {
    expect(parseUiBlock('root = Text("x")', true).kind).toBe('invalid');
  });

  test('a closed fence cut mid-statement is invalid, never a block with a missing value', () => {
    expect(parseUiBlock('root = Stack([KeyValue([{label: "Budget", value:', true).kind).toBe('invalid');
  });

  test('an element written as an object literal is invalid', () => {
    expect(parseUiBlock('root = Stack([{type: "element", typeName: "Text"}])', true).kind).toBe('invalid');
  });

  test('a chart series must carry one value per label', () => {
    expect(parseUiBlock('root = Stack([BarChart(["a", "b"], [Series("s", [10])])])', true).kind).toBe('invalid');
    expect(parseUiBlock('root = Stack([BarChart(["a", "b"], [Series("s", [10, 20])])])', true).kind).toBe('ready');
  });

  test('a node whose child slot is not a list is invalid, not a crash', () => {
    expect(parseUiBlock('root = Stack([{type: "element", typeName: "Card", props: {children: 1}}])', true).kind).toBe('invalid');
  });
});

describe('blockDecisions', () => {
  test('buttons that share a value make one decision; buttons without one make another', () => {
    const parsed = parseUiBlock([
      'root = Stack([a, b, go])',
      'a = Card("A", [Button("Yes", "primary", "#1"), Button("No", "secondary", "#1")])',
      'b = Card("B", [Button("Yes", "primary", "#2"), Button("No", "secondary", "#2")])',
      'go = Button("Done")',
    ].join('\n'), true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(blockDecisions(parsed.root)).toEqual(['#1', '#2', '']);
  });
});

describe('catalog additions', () => {
  test('a series may leave a point empty with null', () => {
    expect(parseUiBlock('root = Stack([LineChart(["a", "b", "c"], [Series("s", [1, null, 3])])])', true).kind).toBe('ready');
  });

  test('stat, progress and a blocked step parse', () => {
    expect(parseUiBlock([
      'root = Stack([Stat("Installs", 48210, "+12%", "success"), Progress("Budget", 87), Steps([{title: "Review", status: "blocked"}])])',
    ].join('\n'), true).kind).toBe('ready');
  });

  test('a card with an empty title parses', () => {
    expect(parseUiBlock('root = Stack([Card("", [Text("no title")])])', true).kind).toBe('ready');
  });
});
