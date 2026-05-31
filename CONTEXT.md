# OpenChamber — Draw.io Diagram Integration

## Language

**Diagram file**:
A `.drawio` file in the project tree containing draw.io XML markup. It lives alongside other source files and is read/written via the standard filesystem API.

**Diagram View**:
The visual editor surface that renders a diagram file inside a `DrawIoEmbed` iframe. Exists in two forms: inline in the Files view (replacing CodeMirror for `.drawio` files) and as a dedicated `diagram` tab.

**Visual editing**:
Editing a diagram through the draw.io iframe editor (drag-drop, connect, style) as opposed to editing the raw XML in a text editor.

**Collaborative loop**:
The iteration cycle where the OpenCode agent writes/revises `.drawio` XML via the `write` tool, and the user refines it visually in the Diagram View.

## Relationships

- A **Diagram file** is opened and rendered by the **Diagram View**
- The **Diagram View** appears either inline (in the Files view with a Visual/Source toggle) or as a dedicated tab
- The **collaborative loop** is driven by file writes from the agent and visual edits from the user
