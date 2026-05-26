import { tool } from "@opencode-ai/plugin"
import { XMLParser, XMLBuilder } from "fast-xml-parser"
import path from "path"

const PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" })
const BUILDER = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: false })

type Cell = Record<string, unknown>

interface DiagramDoc {
  doc: Record<string, unknown>
  root: { mxCell?: Cell | Cell[] }
}

async function readDiagram(filePath: string): Promise<DiagramDoc> {
  const xml = await Bun.file(filePath).text()
  const doc = PARSER.parse(xml) as Record<string, unknown>
  const diagram = (doc.mxfile as Record<string, unknown>)?.diagram as Record<string, unknown>
  const model = diagram?.mxGraphModel as Record<string, unknown>
  const root = (model?.root ?? diagram?.root) as { mxCell?: Cell | Cell[] }
  return { doc, root }
}

async function writeDiagram(filePath: string, state: DiagramDoc): Promise<void> {
  const xml = BUILDER.build(state.doc)
  await Bun.write(filePath, xml)
}

function ensureCellArray(root: { mxCell?: Cell | Cell[] }): Cell[] {
  if (!root.mxCell) {
    root.mxCell = []
    return root.mxCell as Cell[]
  }
  if (!Array.isArray(root.mxCell)) {
    root.mxCell = [root.mxCell as Cell]
  }
  return root.mxCell as Cell[]
}

const STYLE_MAP: Record<string, string> = {
  process:    "rounded=1;whiteSpace=wrap;html=1;arcSize=20;",
  decision:   "rhombus;whiteSpace=wrap;html=1;",
  terminator: "rounded=1;whiteSpace=wrap;html=1;arcSize=50;",
  document:   "shape=document;whiteSpace=wrap;html=1;",
  cylinder:   "shape=cylinder;whiteSpace=wrap;html=1;",
  ellipse:    "ellipse;whiteSpace=wrap;html=1;",
  cloud:      "shape=cloud;whiteSpace=wrap;html=1;",
  actor:      "shape=actor;whiteSpace=wrap;html=1;",
}

function nextId(cells: Cell[]): string {
  let max = 0
  for (const c of cells) {
    const id = c["@_id"]
    if (typeof id === "string") {
      const m = id.match(/^cell-(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1]))
    }
  }
  return `cell-${max + 1}`
}

function buildStyle(baseType: string, fill?: string, stroke?: string): string {
  let s = STYLE_MAP[baseType] || "rounded=1;whiteSpace=wrap;html=1;"
  if (fill) s += `fillColor=${fill};`
  if (stroke) s += `strokeColor=${stroke};`
  return s
}

export default async function () {
  return {
    tool: {
      diagram_create: tool({
        description: "Create a new blank draw.io diagram file",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file (relative to project)"),
          name: tool.schema.string().optional().describe("Page name (default: Page-1)"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const xml = `<mxfile><diagram name="${args.name || "Page-1"}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
          await Bun.write(filePath, xml)
          return `Created blank diagram: ${args.path}`
        },
      }),

      diagram_add_node: tool({
        description: "Add a shape to a draw.io diagram",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
          type: tool.schema.enum(["process", "decision", "terminator", "document", "cylinder", "ellipse", "cloud", "actor"]).describe("Shape type"),
          label: tool.schema.string().describe("Text label for the shape"),
          x: tool.schema.number().describe("X position (left edge)"),
          y: tool.schema.number().describe("Y position (top edge)"),
          width: tool.schema.number().default(120).describe("Width in pixels"),
          height: tool.schema.number().default(40).describe("Height in pixels; decision defaults to 80"),
          fillColor: tool.schema.string().optional().describe("Hex fill color (e.g. #dae8fc)"),
          strokeColor: tool.schema.string().optional().describe("Hex stroke color (e.g. #6c8ebf)"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const id = nextId(cells)
          const w = args.width ?? 120
          const h = args.type === "decision" ? (args.height ?? 80) : (args.height ?? 40)
          const style = buildStyle(args.type, args.fillColor, args.strokeColor)
          cells.push({
            "@_id": id,
            "@_vertex": "1",
            "@_parent": "1",
            "@_style": style,
            "@_value": args.label,
            mxGeometry: { "@_x": args.x, "@_y": args.y, "@_width": w, "@_height": h, "@_as": "geometry" },
          })
          await writeDiagram(filePath, state)
          return `Added ${args.type} "${args.label}" as ${id} at (${args.x}, ${args.y})`
        },
      }),

      diagram_add_edge: tool({
        description: "Connect two nodes with an edge line",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
          source: tool.schema.string().describe("Source node ID (e.g. cell-1)"),
          target: tool.schema.string().describe("Target node ID (e.g. cell-2)"),
          label: tool.schema.string().optional().describe("Edge label (e.g. Yes, No)"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const id = nextId(cells)
          const style = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=0;endSize=8;strokeWidth=1;"
          const cell: Cell = {
            "@_id": id,
            "@_edge": "1",
            "@_parent": "1",
            "@_source": args.source,
            "@_target": args.target,
            "@_style": style,
            mxGeometry: { "@_relative": "1", "@_as": "geometry" },
          }
          if (args.label) cell["@_value"] = args.label
          cells.push(cell)
          await writeDiagram(filePath, state)
          const label = args.label ? ` labeled "${args.label}"` : ""
          return `Connected ${args.source} → ${args.target} as ${id}${label}`
        },
      }),

      diagram_update_node: tool({
        description: "Update a node's label, position, size, or colors",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
          id: tool.schema.string().describe("Node ID to update (e.g. cell-1)"),
          label: tool.schema.string().optional().describe("New text label"),
          x: tool.schema.number().optional().describe("New X position"),
          y: tool.schema.number().optional().describe("New Y position"),
          width: tool.schema.number().optional().describe("New width"),
          height: tool.schema.number().optional().describe("New height"),
          fillColor: tool.schema.string().optional().describe("Hex fill color"),
          strokeColor: tool.schema.string().optional().describe("Hex stroke color"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const cell = cells.find((c) => c["@_id"] === args.id)
          if (!cell) return `Error: node "${args.id}" not found`
          if (args.label !== undefined) cell["@_value"] = args.label
          const geo = cell.mxGeometry as Record<string, unknown> | undefined
          if (geo) {
            if (args.x !== undefined) geo["@_x"] = args.x
            if (args.y !== undefined) geo["@_y"] = args.y
            if (args.width !== undefined) geo["@_width"] = args.width
            if (args.height !== undefined) geo["@_height"] = args.height
          }
          if (args.fillColor || args.strokeColor) {
            let style = (cell["@_style"] as string) || ""
            if (args.fillColor) {
              style = style.replace(/fillColor=[^;]+;/g, "").replace(/;?\s*$/, "") + `;fillColor=${args.fillColor};`
            }
            if (args.strokeColor) {
              style = style.replace(/strokeColor=[^;]+;/g, "").replace(/;?\s*$/, "") + `;strokeColor=${args.strokeColor};`
            }
            cell["@_style"] = style
          }
          await writeDiagram(filePath, state)
          return `Updated ${args.id}`
        },
      }),

      diagram_remove: tool({
        description: "Remove a node and all edges connected to it",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
          id: tool.schema.string().describe("Node ID to remove"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const before = cells.length
          state.root.mxCell = cells.filter((c) => {
            if (c["@_id"] === args.id) return false
            if (c["@_edge"] === "1" && (c["@_source"] === args.id || c["@_target"] === args.id)) return false
            return true
          })
          await writeDiagram(filePath, state)
          const after = (state.root.mxCell as Cell[]).length
          return `Removed ${args.id} and ${before - after} connected edge(s)`
        },
      }),

      diagram_list: tool({
        description: "List all nodes and edges in a diagram",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const vertices = cells.filter((c) => c["@_vertex"] === "1")
          const edges = cells.filter((c) => c["@_edge"] === "1")
          let result = `${args.path} — ${vertices.length} nodes, ${edges.length} edges\n\n`
          if (vertices.length > 0) {
            result += "Nodes:\n"
            for (const v of vertices) {
              const id = v["@_id"] ?? "?"
              const label = (v["@_value"] as string) || "(no label)"
              const style = (v["@_style"] as string) || ""
              const type = Object.entries(STYLE_MAP).find(([, s]) => style.includes(s.split(";")[0]))?.[0] || "unknown"
              const geo = v.mxGeometry as Record<string, unknown> | undefined
              const pos = geo ? `(${geo["@_x"]}, ${geo["@_y"]}) ${geo["@_width"]}x${geo["@_height"]}` : "no geometry"
              result += `  ${id}  | ${type.padEnd(10)} | "${label}"  ${pos}\n`
            }
          }
          if (edges.length > 0) {
            result += "\nEdges:\n"
            for (const e of edges) {
              const id = e["@_id"] ?? "?"
              const src = e["@_source"] ?? "?"
              const tgt = e["@_target"] ?? "?"
              const label = e["@_value"] ? `"${e["@_value"]}"` : ""
              result += `  ${id}  ${src} → ${tgt}  ${label}\n`
            }
          }
          return result
        },
      }),

      diagram_layout: tool({
        description: "Auto-layout nodes in a vertical or horizontal flow",
        args: {
          path: tool.schema.string().describe("Path to the .drawio file"),
          direction: tool.schema.enum(["vertical", "horizontal"]).default("vertical"),
          spacingX: tool.schema.number().default(160).describe("Horizontal gap between nodes"),
          spacingY: tool.schema.number().default(100).describe("Vertical gap between nodes"),
        },
        async execute(args) {
          const filePath = path.resolve(args.path)
          const state = await readDiagram(filePath)
          const cells = ensureCellArray(state.root)
          const vertices = cells.filter((c) => c["@_vertex"] === "1") as (Cell & { mxGeometry: Record<string, unknown> })[]
          const sorted = vertices.filter((v) => v.mxGeometry && v.mxGeometry["@_x"] !== undefined)
          sorted.sort((a, b) => {
            const gA = a.mxGeometry
            const gB = b.mxGeometry
            if (args.direction === "vertical") {
              const diff = (gA["@_y"] as number) - (gB["@_y"] as number)
              return diff !== 0 ? diff : (gA["@_x"] as number) - (gB["@_x"] as number)
            }
            const diff = (gA["@_x"] as number) - (gB["@_x"] as number)
            return diff !== 0 ? diff : (gA["@_y"] as number) - (gB["@_y"] as number)
          })
          let cx = 40
          let cy = 40
          const sx = args.spacingX ?? 160
          const sy = args.spacingY ?? 100
          for (const v of sorted) {
            const w = Number(v.mxGeometry["@_width"]) || 120
            const h = Number(v.mxGeometry["@_height"]) || 40
            v.mxGeometry["@_x"] = cx
            v.mxGeometry["@_y"] = cy
            v.mxGeometry["@_width"] = w
            v.mxGeometry["@_height"] = h
            if (args.direction === "vertical") {
              cy = cy + h + sy
            } else {
              cx = cx + w + sx
            }
          }
          await writeDiagram(filePath, state)
          return `Laid out ${sorted.length} nodes ${args.direction}ly`
        },
      }),
    },
  }
}
