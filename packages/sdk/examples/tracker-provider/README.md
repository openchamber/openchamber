# Teaboard Tracker

An extension that adds a work item tracker to OpenChamber, next to Linear. It
declares `contributes.service.provides: ["tracker"]` and describes the tracker
in `contributes.tracker`: its name, that the user types the server's address,
that the token travels as a bearer, what it can do, which state filters it
offers, the shape of its identifiers (`TEA-1`) and where an item's page lives
on the server. OpenChamber names the tracker `ext-tracker-provider`, draws its
card under Extension accounts in Settings → Integrations from that description,
keeps the account and its token, and recognises `/items/TEA-1` links on the
connected server as that item. The service never sees the token.

Teaboard is not a real product. `tracker-server.ts` is a small in-memory
tracker with two projects (`TEA`, `OPS`) and six items in different states,
with labels, priorities and assignees, behind one bearer. It exists so the
example can be tried end to end on one machine.

## Try it

1. Start the fake tracker: `bun packages/sdk/examples/tracker-provider/tracker-server.ts`.
   It prints its address (`http://127.0.0.1:4568`) and its token (`demo`).
   `TEABOARD_PORT` and `TEABOARD_TOKEN` change them.
2. In **Settings → Extensions**, add this folder and allow the local service.
3. In **Settings → Integrations**, under **Extension accounts**, on the
   **Teaboard** card, enter the address and the token and connect. The card
   shows the account the server reported, Mona Teapot.
4. Open the item picker from a session's composer and search for `oolong` or
   `TEA-1` (the done kettle item, `TEA-3`, shows under the `All` filter);
   attach an item, or start a worktree from one. Under the card,
   map the `TEA` and `OPS` projects to folders and turn on session comments:
   the fake tracker then prints a `[comment]` line when a session starts and
   when it completes. As with Linear, a comment carries a link to the
   session, so OpenChamber posts one only when it is reached on a public
   address; on `localhost` or a LAN address the post is skipped.

Changing an item's state from OpenChamber prints a `[state]` line. Everything
the fake tracker keeps is lost when it stops.

## What each call does

OpenChamber posts every call to the service at `POST /tracker`. The service
reaches the server only through `createTrackerOutbound`, which posts each
request to OpenChamber's callback listener with the call's handle; OpenChamber
adds the token and keeps the request on the account's server.

| Call | Request to Teaboard | Answer |
| --- | --- | --- |
| `auth.probe` | `GET /api/health`, without a token | `supported` when the server says `{ "teaboard": true }` |
| `auth.verify` | `GET /api/me` | the account the token belongs to |
| `items.list` | `GET /api/items` with the filters as query parameters | a page of two items, the next cursor and `hasMore` |
| `items.get` | `GET /api/items/{id}` (the id, or the key when OpenChamber resolves a pasted link or identifier) | the item with its description and comments; `item: null` on 404 |
| `items.updateState` | `POST /api/items/{id}/state` with `{ "stateId" }` | the changed item; `item: null` on 404 |
| `items.liveSummaries` | `GET /api/summaries?identifiers=A,B` | title and state per identifier the server knows |
| `states.list` | `GET /api/projects/{containerId}/states` | the project's workflow states in order |
| `containers.list` | `GET /api/projects` | the projects |
| `comments.create` | `POST /api/items/{identifier}/comments` with `{ "body" }` | the comment's id; `comment: null` on 404 |

The service translates between Teaboard's words and OpenChamber's: state kinds
(`unstarted`, `started`, `completed`) become the neutral categories (`todo`,
`in-progress`, `done`), the numeric priority becomes a name, the manifest's
state filters become the server's, and identifiers go out upper-case, the form
OpenChamber compares them in. Items carry no `provider` field; OpenChamber
adds it.

A 401 from the server is answered as `{ ok: false, error: { status: 401 } }`,
which OpenChamber only acts on when its own proxy saw the server answer 401.
A request OpenChamber refuses, such as a write through a read's handle, is
answered with the proxy's status and code.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/tracker-provider/service/main.ts packages/sdk/examples/tracker-provider/service/main.js
```

`scripts/tracker-provider-example.test.ts` runs the built service against the
fake tracker and a stand-in for OpenChamber's outbound proxy, and checks each
call, including a write the proxy refuses.
