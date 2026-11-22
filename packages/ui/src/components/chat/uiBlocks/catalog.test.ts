import { GUEST_BLOCK_RESERVED_NAMES } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import { NO_EXTENSION_BLOCKS, collectExtensionBlocks, blockDecisions, blockFields, blockNode, cardDecision, decisionTitles, blockProps, noteSlot, parseUiBlock, type BlockValue, type UiBlockParse } from './catalog';

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

  test('a key in a call is reported as a named argument, alone', () => {
    const errorsOf = (source: string) => {
      const parsed = parseUiBlock(source, true);
      if (parsed.kind !== 'invalid') throw new Error(`expected invalid, got ${parsed.kind}`);
      return parsed.errors;
    };
    expect(errorsOf('root = Stack([c])\nc = Choice("a", [{label: "A"}], label: "Pick one")')).toEqual(["Named arguments aren't supported: pass label by position"]);
    expect(errorsOf('root = Stack([Badge(label: "x",\n  tone: "info")])')).toEqual(["Named arguments aren't supported: pass label, tone by position"]);
    expect(errorsOf('root = Stack([Slider("b", 0, 10, step: 5)])')).toEqual(["Named arguments aren't supported: pass step by position"]);
    expect(errorsOf('root = Stack([Badge("x", "info", tone: "error")])')).toEqual(["Named arguments aren't supported: pass tone by position"]);
  });

  test('a reply block that keeps its sound parts names the key under them', () => {
    const parsed = parseUiBlock('root = Stack([Text("kept"), Badge("x", tone: "info")])', true, true);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${parsed.kind}`);
    expect(parsed.dropped).toEqual(["Named arguments aren't supported: pass tone by position"]);
  });

  test('a form with a key stays invalid in a reply and names the key', () => {
    expect(parseUiBlock('root = Stack([Choice("a", ["x"], label: "Pick")])', true, true)).toEqual({ kind: 'invalid', errors: ["Named arguments aren't supported: pass label by position"] });
  });

  test('a key the parser never read keeps the real error', () => {
    expect(parseUiBlock('root = Stack([\n  // see Foo(bar, baz: 1)\n  missing\n])', true)).toEqual({ kind: 'invalid', errors: ['Undefined names: missing'] });
    expect(parseUiBlock('Here is a form (simple, style: plain)\nroot = Stack([missing])', true)).toEqual({ kind: 'invalid', errors: ['Undefined names: missing'] });
  });

  test('a wrong closing bracket does not turn an object key into a named argument', () => {
    const parsed = parseUiBlock('root = Stack([Choice("a", {label: "A"), description: "x"})])', true);
    if (parsed.kind !== 'invalid') throw new Error(`expected invalid, got ${parsed.kind}`);
    expect(parsed.errors.join('\n')).not.toContain('Named arguments');
  });

  test('object keys, strings and ternaries are not named arguments', () => {
    expect(parseUiBlock('root = Stack([missing, Choice("a", [{label: "A"}], "Pick one")])', true)).toEqual({ kind: 'invalid', errors: ['Undefined names: missing'] });
    expect(parseUiBlock('root = Stack([missing, Text("a, label: b")])', true)).toEqual({ kind: 'invalid', errors: ['Undefined names: missing'] });
    expect(parseUiBlock('root = Stack([missing, Text(x ? y : "z")])', true)).toEqual({ kind: 'invalid', errors: ['Undefined names: missing, x, y'] });
    expect(parseUiBlock('root = Stack([Text("a", "b")])', true)).toEqual({ kind: 'invalid', errors: ['Text: Text takes 1 arg(s), got 2 (1 excess dropped)'] });
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

describe('a reply salvaging a block', () => {
  const salvaged = (...lines: string[]) => parseUiBlock(lines.join('\n'), true, true);
  const childNames = (parsed: UiBlockParse) => (parsed.kind === 'ready'
    ? (blockProps.Stack.parse(blockNode.parse(parsed.root).props).children).map((child) => blockNode.parse(child).typeName)
    : parsed.kind);
  const dropped = (parsed: UiBlockParse) => (parsed.kind === 'ready' ? parsed.dropped : parsed.kind);

  test('draws what is sound and names what it lost', () => {
    const parsed = salvaged(
      'root = Stack([chart, note])',
      'chart = BarChart(["a", "b"], [Series("s", [1, 2])])',
      'note = Callout()',
    );
    expect(childNames(parsed)).toEqual(['BarChart']);
    expect(String(dropped(parsed))).toContain('Callout');
  });

  const survives: [string, string[]][] = [
    ['an undefined name', ['root = Stack([a, gone])', 'a = Badge("ok")']],
    ['an unused name', ['root = Stack([a])', 'a = Badge("ok")', 'b = Badge("left out")']],
    ['an unknown component', ['root = Stack([a, b])', 'a = Badge("ok")', 'b = Pie("x")']],
    ['a chart with the wrong number of values', ['root = Stack([a, b])', 'a = Badge("ok")', 'b = BarChart(["x", "y"], [Series("s", [1])])']],
  ];
  for (const [name, lines] of survives) {
    test(`survives ${name}`, () => {
      const parsed = salvaged(...lines);
      expect(childNames(parsed)).toEqual(['Badge']);
      expect(dropped(parsed)).toHaveLength(1);
    });
  }

  test('keeps a whole block whole, with nothing dropped', () => {
    expect(dropped(salvaged('root = Stack([Badge("ok")])'))).toEqual([]);
  });

  const refused: [string, string[]][] = [
    ['a form that lost a part', ['root = Stack([c, d])', 'c = Choice("a", ["x"])', 'd = Callout()']],
    ['a lost field', ['root = Stack([a, c])', 'a = Badge("ok")', 'c = Choice("a")']],
    ['a lost button', ['root = Stack([a, b])', 'a = Badge("ok")', 'b = Button(1)']],
    ['a form under a broken parent', ['root = Stack([a, c])', 'a = Badge("ok")', 'c = Card(1, [Choice("pick", ["A", "B"])])']],
    ['a form left unused', ['root = Stack([a])', 'a = Badge("ok")', 'c = Choice("pick", ["A", "B"])']],
    ['an expression over an undefined name', ['root = Stack([a, s])', 'a = Badge("ok")', 's = Stat("Revenue", missing * 100)']],
    ['a block cut short', ['root = Stack([a])', 'a = Badge("no']],
    ['a block with nothing left', ['root = Stack([d])', 'd = Callout()']],
    ['no Stack root', ['root = Card("x", [Badge("ok")])']],
  ];
  for (const [name, lines] of refused) {
    test(`refuses ${name}`, () => {
      expect(salvaged(...lines).kind).toBe('invalid');
    });
  }

  test('a page keeps the whole block invalid', () => {
    expect(parseUiBlock('root = Stack([a, d])\na = Badge("ok")\nd = Callout()', true).kind).toBe('invalid');
  });

  test('a fold with nothing inside goes without a word, on a page and in a form too', () => {
    const source = 'root = Stack([c, d])\nc = Choice("a", ["x"])\nd = Details("Method notes")';
    expect(childNames(parseUiBlock(source, true))).toEqual(['Choice']);
    expect(dropped(salvaged(source))).toEqual([]);
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

describe('extension blocks', () => {
  const extensions = collectExtensionBlocks([{ guestId: 'desk', name: 'DeskChart', description: 'A chart', args: ['title', 'values'], entry: 'b.html' }]);

  test('a call parses with its arguments under their names', () => {
    const parsed = parseUiBlock('root = Stack([chart])\nchart = DeskChart("Builds", "3,5,8")', true, false, extensions);
    if (parsed.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(parsed)}`);
    const [chart] = childrenOf(parsed.root);
    expect(chart.typeName).toBe('DeskChart');
    expect(chart.props).toMatchObject({ title: 'Builds', values: '3,5,8' });
  });

  test('it sits inside a card like any other item', () => {
    const parsed = parseUiBlock('root = Stack([Card("Stats", [DeskChart("Builds", "3")])])', true, false, extensions);
    expect(parsed.kind).toBe('ready');
  });

  test('without the extension the name is unknown and a reply draws the rest', () => {
    const source = 'root = Stack([note, chart])\nnote = Text("Before")\nchart = DeskChart("Builds", "3")';
    expect(parseUiBlock(source, true).kind).toBe('invalid');
    const salvaged = parseUiBlock(source, true, true);
    if (salvaged.kind !== 'ready') throw new Error(`expected ready, got ${salvaged.kind}`);
    expect(childrenOf(salvaged.root).map((child) => child.typeName)).toEqual(['Text']);
    expect(salvaged.dropped.join('\n')).toContain('DeskChart');
  });

  test('a name the catalog or an earlier extension holds is left out', () => {
    const taken = collectExtensionBlocks([
      { guestId: 'a', name: 'Card', description: 'x', args: [], entry: 'a.html' },
      { guestId: 'a', name: 'First', description: 'x', args: [], entry: 'a.html' },
      { guestId: 'b', name: 'First', description: 'x', args: [], entry: 'b.html' },
    ]);
    expect([...taken.keys()]).toEqual(['First']);
    expect(taken.get('First')?.guestId).toBe('a');
  });

  test('no extension means the same empty set, so a parse keeps its memo', () => {
    expect(collectExtensionBlocks([])).toBe(NO_EXTENSION_BLOCKS);
  });
});

test('the SDK reserves exactly the names of the catalog', () => {
  expect([...GUEST_BLOCK_RESERVED_NAMES].sort()).toEqual(Object.keys(blockProps).sort());
});
