### Components
Table(columns: Col[])
Col(label: string, data: any, type?: "string" | "number" | "action")
BarChart(labels: string[], series: Series[], variant?: "grouped" | "stacked", xLabel?: string, yLabel?: string, height?: number, options?: {layout?: "fit" | "scroll", density?: "compact" | "default" | "spacious", legend?: boolean, grid?: boolean, showYAxis?: boolean, tickVariant?: "singleLine" | "multiLine" | "angled", palette?: number[], orientation?: "vertical" | "horizontal"})
LineChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, options?: {layout?: "fit" | "scroll", density?: "compact" | "default" | "spacious", legend?: boolean, grid?: boolean, showYAxis?: boolean, tickVariant?: "singleLine" | "multiLine" | "angled", palette?: number[]})
AreaChart(labels: string[], series: Series[], variant?: "linear" | "natural" | "step", xLabel?: string, yLabel?: string, height?: number, options?: {layout?: "fit" | "scroll", density?: "compact" | "default" | "spacious", legend?: boolean, grid?: boolean, showYAxis?: boolean, tickVariant?: "singleLine" | "multiLine" | "angled", palette?: number[]})
Series(category: string, values: number[])
PieChart(labels: string[], values: number[], variant?: "pie" | "donut", appearance?: "circular" | "semiCircular", options?: {legend?: boolean, palette?: number[]})
