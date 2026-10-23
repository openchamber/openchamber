# Bots UI contract

## 1. Identity

Bots extends the existing project-rail pages. Attention, recorded evidence and explicit configuration are the hierarchy. There is no overview dashboard or decorative metric grid.

## 2. Color

Use the current theme's surface, foreground, muted foreground, interactive selection and hover tokens. Status warning and error fills describe actual waits, absent proof and failures. Shared Button owns primary actions. No new palette, shadows or colored selection edges.

## 3. Typography

Use typography-ui-header, typography-ui-label, typography-meta and the Settings typography classes. Fonts remain the user's --font-sans and --font-mono. Paths, IDs, commands and hashes are LTR. User titles and evidence use dir="auto" and wrap long strings.

## 4. Spacing and layout

Use the existing 4px spacing scale, including shared compact 1.5 steps. ProjectRailPage owns desktop project navigation and content scrolling. Mobile has one overflow-y-auto body and a content-sized project picker. Config uses an active-pill tab strip and shared Settings rows, sections and container queries. No nested scroll body inside that page. Detail replaces the list in the same region and has an explicit Back action.

The spatial reference is StyleGallery's fixed-sidenav-shell: https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md. The rail stays fixed; the bounded shrinking content body scrolls.

## 5. Components

- Button, Input, Textarea, Select, NumberInput and Settings fields retain shared default, focus, disabled and invalid states. No new primitive is introduced.
- SortableTabsStrip uses active-pill without reordering. Tabs scroll horizontally at narrow widths and stay one row.
- Bot rows use oc-tile with inline titles and reserved action space. Item rows show state, title and token count. Empty and failed loads are distinct.
- ModelSelector and AgentSelector own catalog loading and keyboard/touch selection. Every read names the selected project's directory.
- McpToolPermissionsEditor owns per-tool Allow/Ask/Deny and catalog failure behavior. Investigation/judge and correction have separate rules.
- Plain-text evidence and reports wrap in flat sections. Proof absence, unsuccessful proof and judge reasons are always visible in detail and audit.
- Policy review displays exact file, fingerprint and content before an explicit approval. A changed rule is human until approved.
- Identity forms keep secrets only in mounted component state, clear them after submission/unmount and never hydrate a secret from a response.
- The Bots sidebar zone contains live blocking requests or server-owned needs-you items, hides when empty, and opens the stage session or item. Ordinary project lists exclude bot metadata and its descendants.

## 6. Motion and interaction

Reuse shared controls and surfaces. Introduce no animation, clock or polling. Refresh is explicit and server events invalidate only the shown project. Mutations disable their action while pending; errors stay beside the action. Existing drafts survive failure. Runtime changes retire requests and clear the visit, including secrets.

## 7. Depth

Layout stays flat. Lists use oc-tile, nested report blocks use oc-tile-inset only where needed. Shared controls supply the raised edge. Only section dividers and existing page rail separation draw lines.

## 8. Accessibility constraints and accepted debt

Every input and action has a translated accessible label. Tab navigation and popups use shared components. Logical start/end classes mirror RTL. Keyboard and touch users can reach every section and action; long labels wrap in forms and truncate with titles in rows. Errors use role="alert"; asynchronous status uses role="status". No accessibility debt is accepted. Browser, theme, mobile and RTL evidence belongs to the coordinator's combined runtime QA; static checks do not establish paint correctness.
