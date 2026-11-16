# Agent Desk

A service that acts on its own, and everything it can give an agent.

- `service.keepRunning` starts it with OpenChamber, and `service.schedule` wakes it every minute. Each tick goes to the open panel through `emit`.
- `sessionControl` lets the panel's Start button open a session with no agent tool involved. `content` lets it read the reply.
- `instructions` adds a line to what agents read in every session.
- `marks` puts the desk's icon on the sidebar row of each session it started. A click on it opens the panel.
- `skills` ships `deploy-notes` to every agent while the extension is on.
- `mentions` adds **Desk notes** to the composer's `@` menu. Picking one attaches its text.
- `blocks` lets an agent write `DeskChart("Builds", "3,5,8")` in a UI block, drawn by `blocks/chart.html`. Its button answers the agent.
- `actions` adds entries on selected text, a Files row and selected lines.

Add this folder in Settings → Extensions, allow what it asks for, and open its rail panel.
