# Browser provider stub

An extension that stands in for the agent's browser without opening one. It
declares `contributes.service.provides: ["browser"]` and answers every
`browser.*` action at `POST /browser-control` from one in-memory page. The
host starts the service on the first action and stops it after ten idle
minutes.

It also declares `surface: true`, so it gets a rail panel the host draws: the
fake page painted as rectangles, a red square where you last clicked, a stripe
along the top showing who is in control (blue agent, green you), and a hue
that shifts on every key. Click the picture to take control, press "Hand back
to agent" to give it back; while you hold it, an agent's browser action is
refused with a message telling it to wait.

Use it to see the host side work before writing a real provider:

1. `bunx openchamber-guest-bundle --node service/main.ts service/main.js` in this folder.
2. Install the folder from Settings → Extensions and allow the local service.
3. Settings → General → OpenChamber Tools → Browser provider: pick "Browser Provider Stub".
4. Ask an agent to open a page and read it. The snapshot says it came from the stub.
5. Open the extension's panel from the rail to watch, click into it, then hand control back.

A real provider keeps this shape and replaces `page` with a browser it drives
(Chrome over CDP, for example). The request and result types are exported from
`@openchamber/sdk`; the contract is in `GUEST_SERVICES.md`.
