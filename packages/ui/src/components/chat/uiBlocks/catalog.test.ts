import { describe, expect, test } from 'bun:test';
import { blockDecisions, blockFields, blockNode, cardDecision, decisionTitles, blockProps, noteSlot, parseUiBlock, type BlockValue } from './catalog';

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

  test('Choice options take a label or a label with a description', () => {
    const parsed = parseUiBlock('root = Stack([Choice("plan", ["Keep", {label: "Move", description: "Moves the job to Monday"}])])', true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(blockProps.Choice.parse(childrenOf(parsed.root)[0].props).options).toEqual(['Keep', { label: 'Move', description: 'Moves the job to Monday' }]);
  });

  test('a slider needs max above min, and a date its ISO shape', () => {
    expect(parseUiBlock('root = Stack([Slider("budget", 10, 5)])', true).kind).toBe('invalid');
    expect(parseUiBlock('root = Stack([DateInput("when", "When", true, "next Monday")])', true).kind).toBe('invalid');
    expect(parseUiBlock('root = Stack([DateInput("when", "When", true, "2026-11-09T09:00"), Slider("budget", 0, 100)])', true).kind).toBe('ready');
  });

  test('prefilled fields start as their answer reads: a time only when asked, a slider on a step it can stand on', () => {
    const parsed = parseUiBlock('root = Stack([Details("More", [DateInput("when", "", false, "2026-11-09T18:30"), DateInput("at", "", true, "2026-11-10")]), Slider("budget", 0, 50, "Budget", 5, 20), Slider("sessions", 1, 10, "", 2, 99), Slider("share", 0, 100, "", 10)])', true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(blockFields(parsed.root)).toEqual([
      { name: 'when', label: 'when', initial: '2026-11-09' },
      { name: 'at', label: 'at', initial: '2026-11-10T09:00' },
      { name: 'budget', label: 'Budget', initial: '20' },
      { name: 'sessions', label: 'sessions', initial: '9' },
      { name: 'share', label: 'share', initial: '50' },
    ]);
  });

  test('a node whose child slot is not a list is invalid, not a crash', () => {
    expect(parseUiBlock('root = Stack([{type: "element", typeName: "Card", props: {children: 1}}])', true).kind).toBe('invalid');
  });
});

describe('blockDecisions', () => {
  test('a titled card is one decision named by its title; elsewhere buttons that share a value are one', () => {
    const parsed = parseUiBlock([
      'root = Stack([a, b, c, go])',
      'a = Card("A", [Button("Yes", "primary", "#1: yes"), Button("No", "secondary", "#1: no")])',
      'b = Card("B", [Button("Yes", "primary"), Button("No", "secondary")])',
      'c = Card("", [Button("Yes", "primary", "#3"), Button("No", "secondary", "#3")])',
      'go = Button("Done")',
    ].join('\n'), true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(blockDecisions(parsed.root)).toEqual(['A', 'B', '#3', '']);
  });

  test('cards that share a title fall back to their values instead of merging', () => {
    const parsed = parseUiBlock([
      'root = Stack([a, b])',
      'a = Card("Deploy", [Button("Yes", "primary", "#1"), Button("No", "secondary", "#1")])',
      'b = Card("Deploy", [Button("Yes", "primary", "#2"), Button("No", "secondary", "#2")])',
    ].join('\n'), true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(blockDecisions(parsed.root)).toEqual(['#1', '#2']);
  });
});

describe('cardDecision', () => {
  const titled = (source: string) => {
    const parsed = parseUiBlock(`root = Stack([c])\nc = ${source}`, true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    return blockProps.Stack.parse(blockNode.parse(parsed.root).props).children[0];
  };
  const cardDecisionOf = (source: string) => {
    const card = titled(source);
    return cardDecision(card, decisionTitles(card));
  };

  test('is the card title, whatever values its buttons carry, also inside a row', () => {
    expect(cardDecisionOf('Card("A", [Text("x"), Row([Button("Yes", "primary", "#1: yes"), Button("No", "secondary", "#1: no")])])')).toBe('A');
  });

  test('an untitled card is one decision only when its buttons share a value', () => {
    expect(cardDecisionOf('Card("", [Button("Yes", "primary", "#1"), Button("No", "secondary", "#1")])')).toBe('#1');
    expect(cardDecisionOf('Card("", [Button("Yes", "primary", "#1"), Button("No", "secondary", "#2")])')).toBeNull();
  });

  test('is null for a card with a field or no buttons', () => {
    expect(cardDecisionOf('Card("A", [Input("why"), Button("Yes", "primary", "#1")])')).toBeNull();
    expect(cardDecisionOf('Card("A", [Text("x")])')).toBeNull();
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

describe('noteSlot', () => {
  const root = (source: string) => {
    const parsed = parseUiBlock(source, true);
    if (parsed.kind !== 'ready') throw new Error(parsed.kind);
    return parsed.root;
  };

  test('goes before the last run of buttons, inside the card that holds them', () => {
    expect(noteSlot(root([
      'root = Stack([intro, form])',
      'intro = Text("Pick one")',
      'form = Card("Scope", [Choice("scope", ["Minimal", "Broad"]), Button("Send", "primary"), Button("Skip", "secondary")])',
    ].join('\n')))).toEqual({ parent: '1', index: 1 });
  });

  test('a row of buttons moves as one, and a block without buttons has no place', () => {
    expect(noteSlot(root('root = Stack([Choice("a", ["x"]), Row([Button("Send"), Button("Skip")])])'))).toEqual({ parent: '', index: 1 });
    expect(noteSlot(root('root = Stack([Text("no buttons")])'))).toBeNull();
  });
});
