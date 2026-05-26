# opencode-drawio

Create and edit draw.io diagrams directly from OpenCode.

## Installation

```bash
opencode plugin opencode-drawio
```

Or add to `opencode.json`:

```json
{
  "plugin": ["opencode-drawio"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `diagram_create` | Create a new blank `.drawio` file |
| `diagram_add_node` | Add a shape (process, decision, terminator, document, cylinder, ellipse, cloud, actor) |
| `diagram_add_edge` | Connect two nodes with an optional label |
| `diagram_update_node` | Modify a node's label, position, size, or colors |
| `diagram_remove` | Remove a node and all its connected edges |
| `diagram_list` | Show all nodes and edges in a diagram |
| `diagram_layout` | Auto-arrange nodes vertically or horizontally |

## Usage

Ask the agent to create a flowchart:

> "Create a login flowchart as a .drawio file"

The agent will use the tools to build the diagram step by step:

1. `diagram_create(path="login-flow.drawio")`
2. `diagram_add_node(path="login-flow.drawio", type="terminator", label="Start", x=160, y=20)`
3. `diagram_add_node(path="login-flow.drawio", type="process", label="Check credentials", x=150, y=100)`
4. `diagram_add_node(path="login-flow.drawio", type="decision", label="Valid?", x=160, y=220)`
5. `diagram_add_edge(path="login-flow.drawio", source="cell-1", target="cell-2")`
6. `diagram_add_edge(path="login-flow.drawio", source="cell-2", target="cell-3")`

Then open the file in your draw.io editor (or OpenChamber's inline editor) to refine.

## Shape types

| Type | Style |
|------|-------|
| `process` | Rounded rectangle |
| `decision` | Diamond |
| `terminator` | Pill shape (start/end) |
| `document` | Document shape |
| `cylinder` | Database cylinder |
| `ellipse` | Oval / circle |
| `cloud` | Cloud shape |
| `actor` | Stick figure |

## Requirements

- OpenCode v1.14.0 or later
- The diagram files can be opened in any draw.io editor (app.diagrams.net, draw.io desktop, or OpenChamber's inline editor)

## License

MIT
