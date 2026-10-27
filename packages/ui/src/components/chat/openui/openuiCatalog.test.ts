import { describe, expect, test } from 'bun:test';
import { deriveOpenUICatalog } from './openuiCatalog.schema';
import { OPENUI_COMPONENT_NAMES, OPENUI_RESIDENT_COMPONENT_NAMES } from './openuiSchema';
import { inspectOpenUIProgram, walkRenderedOpenUINodes } from '../../../../../web/shared/openui/program.js';
import { createParser } from '@openuidev/lang-core';

describe('OpenUI catalog', () => {
  test('accepts responsive grids, upstream collections and component options', () => {
    const catalog = deriveOpenUICatalog();
    const source = `root = Stack([Card([Grid([
      GridItem([Image("Hero", "/tmp/hero.png", {aspectRatio: 1.5, fit: "cover"})], 2, 2),
      ImageGallery([{src: "/tmp/detail.png", alt: "Detail", details: "A detail"}]),
      Carousel([[TextContent("First")], [TextContent("Second")]]), Separator()
    ], {columns: [2, 1], minChildWidth: 12})]),
    Icon("search-line", {size: "lg", tone: "muted"}),
    BarChart(["A"], [Series("Count", [2])], null, null, null, null, {orientation: "horizontal", layout: "scroll"})
    ], null, null, null, null, null, {maxWidth: 48, padding: "m"})`;
    expect(inspectOpenUIProgram(source, catalog.schema, catalog.componentSlots)).toMatchObject({ valid: true });
    expect(catalog.componentSlots).toContainEqual({ component: 'Grid', prop: 'children', allowed: expect.arrayContaining(['GridItem', 'ImageGallery']) });
  });

  test('derives the selected component catalog with HtmlView in Card children', () => {
    const catalog = deriveOpenUICatalog();
    expect(OPENUI_COMPONENT_NAMES).toHaveLength(48);
    expect(OPENUI_RESIDENT_COMPONENT_NAMES).toHaveLength(19);
    expect(OPENUI_RESIDENT_COMPONENT_NAMES).toContain('Icon');
    const names = new Set<string>(OPENUI_COMPONENT_NAMES);
    expect(Object.keys(catalog.schema.$defs ?? {}).filter((name) => names.has(name)).sort())
      .toEqual([...OPENUI_COMPONENT_NAMES].sort());
    expect(catalog.componentSlots).toContainEqual({ component: 'Card', prop: 'children', allowed: expect.arrayContaining(['HtmlView']) });
    expect(catalog.componentSlots).toContainEqual({ component: 'Card', prop: 'children', allowed: expect.arrayContaining(['Card', 'Icon']) });
  });

  test('accepts a complete Stack and rejects incomplete or external programs', () => {
    const catalog = deriveOpenUICatalog();
    expect(inspectOpenUIProgram('root = Stack([])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: true });
    expect(inspectOpenUIProgram('card = Stack([])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: false });
    expect(inspectOpenUIProgram('card = Card([HtmlView("<p>Summary</p>")])\nroot = Stack([card])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: true });
    expect(inspectOpenUIProgram('root = Stack([', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: false });
    expect(inspectOpenUIProgram('items = Query("tool", {})\nroot = Stack([])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: false });
  });

  test('accepts a reactive form and chart while rejecting mixed host actions', () => {
    const catalog = deriveOpenUICatalog();
    const source = [
      '$name = "Alice"',
      'form = Form("prefs", Buttons([Button("Send", @ToAssistant("Use name"))]), [FormControl("Name", Input("name", null, "text", null, $name))])',
      'chart = BarChart(["One", "Two"], [Series("People", [1, 2])])',
      'root = Stack([form, chart])',
    ].join('\n');
    expect(inspectOpenUIProgram(source, catalog.schema, catalog.componentSlots)).toMatchObject({ valid: true });
    expect(inspectOpenUIProgram('root = Stack([FormControl("Flag", SwitchGroup("flag", []))])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: true });
    expect(inspectOpenUIProgram('root = Stack([Button("Send", Action([@ToAssistant("Send"), @Reset(["name"])]))])', catalog.schema, catalog.componentSlots)).toMatchObject({ valid: false });
  });

  test('the pure core evaluator implements every official built-in function', () => {
    const catalog = deriveOpenUICatalog();
    const source = `root = Stack([
      @Count([1, 2]), @First([3, 4]), @Last([3, 4]), @Sum([2, 4]), @Avg([2, 4]),
      @Min([2, 4]), @Max([2, 4]), @Sort([{n: 2}, {n: 1}], "n"),
      @Filter([{n: 2}, {n: 1}], "n", ">", 1), @Round(1.235, 2), @Abs(-3), @Floor(1.9), @Ceil(1.1),
      @Each(["a", "b"], "entry", TextContent(entry))
    ])`;
    const program = inspectOpenUIProgram(source, catalog.schema, catalog.componentSlots);
    if (!program.valid) throw new Error(JSON.stringify(program.diagnostics));
    expect(program.root.props.children).toMatchObject([
      2, 3, 4, 6, 3, 2, 4, [{ n: 1 }, { n: 2 }], [{ n: 2 }], 1.24, 3, 1, 2,
      [{ typeName: 'TextContent', props: { text: 'a' } }, { typeName: 'TextContent', props: { text: 'b' } }],
    ]);
    expect(catalog.componentSlots).toContainEqual({ component: 'Stack', prop: 'children', allowed: null });
    expect(catalog.componentSlots).toContainEqual({ component: 'Col', prop: 'data', allowed: null });
  });

  test('rejects unsupported actions in branches that become reachable only after editing', () => {
    const catalog = deriveOpenUICatalog();
    expect(inspectOpenUIProgram(`$show = false
root = Stack([$show ? Button("Bad", Action([@ToAssistant("Send"), @Reset([$show])])) : TextContent("Safe")])`, catalog.schema)).toMatchObject({ valid: false });
    expect(inspectOpenUIProgram(`$show = false
root = Stack([$show ? Button("Bad", @Run(task)) : TextContent("Safe")])`, catalog.schema)).toMatchObject({ valid: false });
  });

  test('authorizes only initial images in real renderable slots, including nested any arrays', () => {
    const catalog = deriveOpenUICatalog();
    const program = inspectOpenUIProgram(`$selected = false
root = Stack([[Image("Initial", "initial.png")], Table([Col("Media", [[Image("Cell", "cell.png")]])]), $selected ? Image("Later", "later.png") : TextContent("Safe")])`, catalog.schema, catalog.componentSlots);
    if (!program.valid) throw new Error(JSON.stringify(program.diagnostics));
    expect(walkRenderedOpenUINodes(program.root, catalog.componentSlots).filter((node) => node.typeName === 'Image').map((node) => node.props.src)).toEqual(['initial.png', 'cell.png']);
    // Metadata-bearing objects are data; they do not become rendered children.
    expect(walkRenderedOpenUINodes({ type: 'element', typeName: 'Stack', partial: false, props: {
      children: [], ignored: { type: 'element', typeName: 'Image', partial: false, props: { src: 'hidden.png' } },
    } }, catalog.componentSlots).filter((node) => node.typeName === 'Image')).toEqual([]);
  });

  test('the producer preserves every official positional prop and default', () => {
    const catalog = deriveOpenUICatalog();
    const parsed = createParser(catalog.schema, 'Stack').parse(`root = Stack([Form("prefs", Buttons([]), [FormControl("Image", OptionCards("cards", null, [OptionCard("a", "A", null, Image("Alt", "a.png"))]))])])`);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.root?.props.children).toMatchObject([{ props: {
      name: 'prefs', buttons: { typeName: 'Buttons' }, fields: [{ props: {
        input: { props: { name: 'cards', type: 'single', items: [{ props: { topContent: { props: { alt: 'Alt', src: 'a.png' } } } }] } },
      } }],
    } }]);
  });

  test('runtime root expressions use the same default-state evaluation and reject non-Stack roots', () => {
    const catalog = deriveOpenUICatalog();
    expect(inspectOpenUIProgram('$show = true\nroot = $show ? Stack([]) : Stack([TextContent("Hidden")])', catalog.schema)).toMatchObject({ valid: true });
    expect(inspectOpenUIProgram('root = TextContent("Wrong root")', catalog.schema)).toMatchObject({ valid: false });
  });
});
