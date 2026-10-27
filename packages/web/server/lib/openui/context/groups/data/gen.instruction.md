# Data

For large chart values, scale the data and put the unit in the axis label (e.g. yLabel "Revenue ($k)") instead of passing raw thousands or millions.

## Official examples

Demonstration data.

### Example 1 — Table (column-oriented):

```openui-lang literal
root = Stack([title, tbl])
title = TextContent("Top Languages", "large-heavy")
tbl = Table([Col("Language", langs), Col("Users (M)", users), Col("Year", years)])
langs = ["Python", "JavaScript", "Java", "TypeScript", "Go"]
users = [15.7, 14.2, 12.1, 8.5, 5.2]
years = [1991, 1995, 1995, 2012, 2009]
```

### Example 2 — Bar chart:

```openui-lang literal
root = Stack([title, chart])
title = TextContent("Q4 Revenue", "large-heavy")
chart = BarChart(labels, [s1, s2], "grouped")
labels = ["Oct", "Nov", "Dec"]
s1 = Series("Product A", [120, 150, 180])
s2 = Series("Product B", [90, 110, 140])
```
