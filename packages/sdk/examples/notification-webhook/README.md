# Webhook Notifier

An extension that delivers your notifications to a server of your choosing,
next to the desktop and the phone. It declares
`contributes.service.provides: ["notifications"]` and describes the channel in
`contributes.notifications`: its name, that the user types the receiver's
address, and that the token travels as a bearer. OpenChamber names the channel
`ext-notification-webhook`, draws its account card in Settings → Integrations
from that description, and keeps the account; the service never sees the token.

The service (`service/main.ts`, built to `service/main.js`) answers the three
calls OpenChamber forwards at `POST /notifications`: `auth.probe` (does this
address answer at all), `auth.verify` (`GET /whoami` on the receiver, who the
token belongs to) and `notify` (`POST /notify` with the notification). Every
request to the receiver goes through `createNotificationsOutbound`, which posts
it to OpenChamber's callback listener with the call's handle; OpenChamber adds
the token and keeps the request on the receiver's origin.

`receiver.ts` is a receiver to try it with: it accepts one bearer, answers
`/whoami`, and prints every notification it gets.

## Try it

1. Start the receiver: `bun packages/sdk/examples/notification-webhook/receiver.ts`.
   It prints its address (`http://127.0.0.1:4567`) and its token (`demo`).
2. In **Settings → Extensions**, add this folder and allow the local service.
   The dialog says the extension delivers your notifications once an account is
   connected.
3. In **Settings → Integrations**, on the **Webhook** card, enter the
   receiver's address and token and connect. The card shows the account the
   receiver reported.
4. Run a turn and switch to another window, or set notifications to always.
   When the agent finishes, the receiver prints `[ready] …` with the same title
   and text the phone would get. Questions, permissions, errors, goal and review
   notifications arrive the same way, following your notification toggles.

Pause the extension and the lines stop. Disconnect the account and they stop
too; connect again to resume. Stop the receiver and OpenChamber logs one line a
minute until it is back.

## What the receiver gets

```json
{"kind":"ready","title":"Agent response is ready","body":"Fix the parser: Done. The parser now…",
 "tag":"ready-ses_…","at":1730000000000,"sessionId":"ses_…","sessionName":"Fix the parser",
 "directory":"/Users/me/repo","url":"/?session=ses_…","account":{"id":"webhook","login":"receiver"}}
```

In enterprise mode the title is the kind's generic title and `body`,
`sessionName` and `directory` are empty, as they are for the phone.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/notification-webhook/service/main.ts packages/sdk/examples/notification-webhook/service/main.js
```

`scripts/notification-webhook-example.test.ts` runs the built service against a
receiver and a stand-in for OpenChamber's outbound proxy, and checks each call.
