# Native composition examples

Choose by the explanation's purpose; adapt the content and labels.

## Staged explanation with paired notes

Use for a process whose stages need supporting explanations. Pair stages with notes;
reuse grid options and keep notes content-height.

```openui-lang literal
root = Stack([heading, prepare, work, result], "column", "m", "stretch", "start", false, {width: "full", maxWidth: 44})
heading = Stack([TextContent("Publishing an edit", "large-heavy"), TextContent("Object R · Example", "small")], "row", "s", "baseline", "between")
prepare = Stack([TextContent("01 · Shared input", "small-heavy"), Grid([input, shared], wide)], "column", "s")
input = Card([Grid([Stack([TextContent("Current result", "small"), TextContent("v1", "large-heavy")], "column", "xs"), Stack([TextContent("Pending draft", "small"), TextContent("v2", "large-heavy")], "column", "xs")], pair)], "sunk")
shared = Stack([Card([TextContent("Shared baseline", "small-heavy"), TextContent("Both tasks use v2; validation matches the output.", "small")], "card", "column", "s")], "row", "none", "start")
work = Stack([TextContent("02 · Parallel work", "small-heavy"), Grid([Stack([Grid([check, build], pair)]), parallel], wide)], "column", "s")
check = Card([Stack([Icon("shield-check-line"), TextContent("Validate", "small-heavy")], "row", "s", "center"), TextContent("Check content and access", "small"), Stack([TextContent("Output", "small"), Tag("Pass / error", null, "sm")], "row", "xs", "center", "start", true)], "card", "column", "s")
build = Card([Stack([Icon("file-copy-line"), TextContent("Generate", "small-heavy")], "row", "s", "center"), TextContent("Build candidate content", "small"), Stack([TextContent("Output", "small"), Tag("Candidate / error", null, "sm")], "row", "xs", "center", "start", true)], "card", "column", "s")
parallel = Stack([Card([TextContent("Execution boundary", "small-heavy"), TextContent("Independent tasks; v1 stays readable until publication.", "small")], "card", "column", "s")], "row", "none", "start")
result = Stack([TextContent("03 · Await both; decide", "small-heavy"), Grid([Stack([Grid([success, failure], pair)]), visibility], wide)], "column", "s")
success = Card([Tag("Both succeed", null, "sm", "success"), TextContent("Publish v2", "small-heavy"), TextContent("Atomically replace v1", "small")], "sunk", "column", "s", "start")
failure = Card([Tag("Either fails", null, "sm", "warning"), TextContent("Keep v1", "small-heavy"), TextContent("Keep draft and errors", "small")], "sunk", "column", "s", "start")
visibility = Stack([Card([TextContent("Visible result", "small-heavy"), Stack([TextContent("After success", "small"), Tag("v2", null, "sm", "info")], "row", "s", "center", "between"), Stack([TextContent("Otherwise", "small"), Tag("v1", null, "sm")], "row", "s", "center", "between")], "card", "column", "s")], "row", "none", "start")
wide = {columns: [2, 1], gap: "m", minChildWidth: 9}
pair = {columns: 2, gap: "s", minChildWidth: 7}
```

## Relationship comparison with state changes

Use when different object relationships produce different outcomes. Align matching
objects; span shared cards and show read/write directions and retained or changed state.

```openui-lang literal
root = Stack([heading, comparison], "column", "m", "stretch", "start", false, {width: "full", maxWidth: 44})
heading = Stack([TextContent("Does B see A's edit?", "large-heavy"), TextContent("Start at v1. A writes v2, then B reads. Copies do not sync.", "small")], "column", "xs")
comparison = Grid([shared, copies], {columns: 2, gap: "l", minChildWidth: 15})
shared = Stack([CardHeader("Shared original", "2 entries · 1 object"), sharedMap, changedResult])
copies = Stack([CardHeader("Independent copies", "2 entries · 2 objects"), copyMap, retainedResult])
sharedMap = Grid([a, b, write, read, GridItem([original], 2)], two)
copyMap = Grid([a, b, write, read, copyA, copyB], two)
a = Stack([TextContent("A · write", "small-heavy")], "column", "none", "center")
b = Stack([TextContent("B · read", "small-heavy")], "column", "none", "center")
write = Stack([Icon("arrow-down-line")], "column", "none", "center")
read = Stack([Icon("arrow-up-line")], "column", "none", "center")
original = Card([TextContent("Shared R", "small-heavy"), change], "sunk", "column", "s", "center")
copyA = Card([TextContent("Copy A", "small-heavy"), change], "sunk", "column", "s", "center")
copyB = Card([TextContent("Copy B", "small-heavy"), Tag("v1 · retained", null, "sm")], "sunk", "column", "s", "center")
change = Stack([TextContent("v1", "small"), Icon("arrow-right-line"), Tag("v2", null, "sm", "info")], "row", "xs", "center", "center")
changedResult = Stack([TextContent("B reads", "small"), Tag("v2", null, "sm", "info"), TextContent("Updated", "small")], "row", "s", "center", "center", true)
retainedResult = Stack([TextContent("B reads", "small"), Tag("v1", null, "sm"), TextContent("Unchanged", "small")], "row", "s", "center", "center", true)
two = {columns: 2, gap: "s", minChildWidth: 6}
```
