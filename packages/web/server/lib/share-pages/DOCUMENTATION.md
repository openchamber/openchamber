# Shared pages

## Ownership

An agent's `openchamber_render` call with `share` sends its page to other
people (a colleague, a manager) by link and PIN through the relay, and each
person's answer comes back into the session that shared it as a message. This
module owns everything on the server after the call: the group on disk, the
crypto, the signed relay calls, polling, delivery and the card's routes.

- `render-page.js` (`../openchamber-control/`) validates the page as for any
  render call, refuses `share` with `awaitAnswer`, and asks `createGroup` for
  the group. The tool result carries `{ title, shared: { recipients,
  expiresAt }, note }` and never a link or PIN: those go no further than this
  store and the card, so they never reach the transcript or the model provider.
- The chat (packages/ui) builds the shared document, a self-contained HTML page
  with its renderer and bootstrap, and posts it. This module seals and uploads
  it; it does not build documents.
- The relay side (openchamber-website `apps/relay`, `src/share/`) stores the
  ciphertext, enforces expiry and the PIN gate, and keeps one answer slot.

## Files

- `expiry.js`: two working days, local time, weekends skipped.
- `crypto.js`: the host side of the crypto contract in the header of the
  relay's `src/share/viewer.ts`.
- `relay-client.js`: availability, which relay, signing, `POST /p`,
  `POST /p/states`, `POST /p/:id/close`.
- `store.js`: `<dataDir>/share-pages/<groupId>.json` and `<groupId>.html`.
- `runtime.js`: groups, uploads, the poller, delivery, cancel.
- `routes.js`: the card's routes, and the received pages' routes.
- `received-link.js`, `received-store.js`, `received-runtime.js`: pages other
  people shared, opened in this app (*Receiving side*, below).

## Contract with the UI

Routes under UI auth, `/api/openchamber/sessions/:sessionId/share-pages/:callId`:

- `GET` -> `{ title, kind, expectAnswer, summary, expiresAt, documentState:
  preparing|ready, recipients: [{ recipientId, label, status:
  preparing|open|locked|answered|expired|cancelled|failed, link, pin, opens,
  answeredAt, answerSummary, error }] }`. `link` (`url#base64url(linkKey)`) and
  `pin` are null until that recipient's share exists on the relay. Every
  route answers 403 `code: 'enterprise_mode'` while sharing is unavailable or
  the group's relay is no longer allowed.
- `POST .../document` `{ html, title, source }` (JSON up to 40 MB): seals the
  document `{ v: 1, title, html, source }` per recipient still without a share
  (new, or failed before) and uploads it. `source` is what the page is made
  from, for a recipient's own agent: `{ format: 'ui', text: <program> }` or
  `{ format: 'html', text: <the agent's HTML before theming>, summary }`; one
  that does not have that shape is left out, and the relay's viewer ignores
  it. It is kept with the group, so a retry seals the same one; answers the group. 409 when nobody is left to upload
  or the share expired first, 413 past the relay's 32 MiB, 403
  `code: 'enterprise_mode'` while sharing is unavailable.
- `POST .../recipients/:recipientId/cancel`: withdraws that link. 409 when
  that person already answered or the link expired.
- `GET .../preview` -> `{ html }`, the local copy for the author's Open.

Every change to a group is broadcast on the OpenChamber control stream as
`openchamber:share-page` `{ sessionId, callId }`; the card reads the group again.

## Invariants

- One group per tool call: its id is a hash of `sessionId` and `callId`, so a
  repeated call finds its group and any id makes a safe file name. One relay
  share per recipient, each with its own 32-byte link key and six-digit PIN.
- Keys and PINs live only in the group file (owner-readable, `0600` in a `0700`
  directory) and the GET answer. They are never logged, never in a tool result,
  never sent to the relay, which receives ciphertext and `SHA-256(auth)` only.
- The lifetime is two working days from the call, in this server's local time
  zone with Saturday and Sunday skipped and every weekday hour counted
  (Friday 17:00 ends Tuesday 17:00, a weekend start ends Wednesday 00:00).
  `expiresInHours` only shortens it. The absolute deadline goes to the relay.
- Every recipient gets the same document: the first one posted is stored as
  the preview and a retry for a failed recipient uploads that copy, whatever
  the later post carries. One failed upload marks that recipient `failed` with
  the error and leaves the others; uploads within a group run one at a time.
- The poller makes one batched `/p/states` call per relay per minute (50 ids
  per request) while any share is open or locked, and keeps ticking while an
  answer is undelivered or an ack is pending. It polls at once on start, after
  OpenCode's event hub connects, after a wake (a 15 s heartbeat that fires more
  than 45 s late means the clock jumped), and on the relay's control-socket
  nudge `{ type: 'share-state', shareId }` while the private relay host runs
  (`../relay/host-client.js`).
- An answer is decrypted and stored with a message id minted before the first
  delivery attempt, so a retry never posts it twice. Delivery is
  `POST /api/session/:id/synthetic` with `delivery: 'steer'`, `resume: true`;
  409 counts as delivered, 404 (session gone) too. Four attempts with backoff
  per poll; what is still undelivered goes out on the next poll, after a
  restart as well.
- Each answer OpenCode admitted (a 2xx, not a 409 replay or a 404) is
  reported once through `onAnswerDelivered`, which `index.js` wires to the
  notifications runtime's `notifyShareAnswer` (toast, desktop, push). A crash
  between the admission and that call loses only the notification.
- Only after delivery is the share closed on the relay (ack), which deletes the
  page and the answer there. An answer that cannot be decrypted marks the
  recipient `failed` and is closed too.
- At most 100 groups stay on disk. Past that, the oldest finished groups go,
  json and local page copy together: finished means every recipient is
  answered (and delivered), expired, cancelled or failed. A group with a
  recipient still preparing, open, locked or with an undelivered answer is
  never removed, nor the group just saved. After removal the card's GET
  answers 404; the answer itself stays in the session as its message.
- Relay replies are parsed at the boundary (`relay-client.js`): a state entry
  that does not match the relay's shape is dropped, never half-applied.
- Cancel reads the share's state first and never withdraws an answered share;
  the answer is taken instead and the call answers 409. A submit between that
  read and the close is not lost: every close (cancel and ack) gets back the
  ciphertext it deleted, and one not stored yet is recorded and delivered like
  a polled answer.
- An answer and its message id are on disk before anything delivers or
  acknowledges it: a failed save puts the recipient back as it was, so the
  next poll reads the answer again and no second id can reach the session.
- A restart in the middle of an upload is finished at start from the stored
  document, for the recipients still `preparing`; the card posts only while
  the document is preparing, so nothing else would.
- In enterprise mode sharing exists only with a pinned relay
  (`isSharingAvailable`), and no call reaches a relay other than the pinned one
  (`isRelayBaseAllowed`), so a share made on another relay before the mode came
  on is left alone: its stored state stays, and every card route (GET,
  preview, document, cancel) answers 403 `code: 'enterprise_mode'`, which the
  card reads as "hide". Answers already accepted are still delivered into the
  session, which stays on this machine. The tool schema follows through the managed config, which
  is rewritten on a policy change.

## Receiving side

A person who got a link and PIN and has OpenChamber opens the page in the app
(decision 0013): the composer turns a pasted link into a chip with a PIN
field, the agent reads the page with the message, and the page opens as a tab
of the context panel, where its Send answers it. The UI is in
`packages/ui/src/components/chat/sharePages/received/`.

Routes under UI auth, `/api/openchamber/received-pages`:

- `GET /config` -> `{ available, bases }`: the relay HTTP bases whose links
  this server opens. Never refused; `available: false` with no bases in
  enterprise mode without a pinned relay.
- `POST /` `{ url }`: takes a pasted link and keeps its key, without waiting
  on the relay, so the page has its id as soon as the link leaves the
  composer. 400 `invalid_link` or `link_not_allowed`.
- `GET /:id`, `POST /:id/status` (asks the relay; 502 when it cannot be read,
  and the state already kept stays), `GET /:id/document` (`{ html }`, 404
  until opened).
- `POST /:id/open` `{ pin }`: proves the PIN and decrypts the page. A wrong
  PIN answers the page with `pinRejected: true` and `attemptsLeft`; locked,
  expired, answered and withdrawn answer the page in that status.
- `POST /:id/answer` `{ data, summary }`: seals `{ v: 1, data, summary,
  submittedAt }` and posts it. 409 after an answer, for a page that takes
  none, or when the relay no longer takes one (`code: page_<status>`).

A page is `{ receivedId, host, status: open|locked|answered|expired|
cancelled|missing, kind, wantsAnswer, expiresAt, attemptsLeft, opened, title,
source, answer }`; changes are broadcast as `openchamber:received-page`
`{ receivedId }`.

Invariants:

- Only links on an allowed relay are taken: `https://share.openchamber.dev`
  and the relay this server shares through, in enterprise mode only the
  pinned relay (`allowedReceiveBases`). A link is `<base>/p/<22-char id>#<43
  base64url chars>`, https, no query or credentials; the relay calls go to
  that base and nowhere else.
- In enterprise mode without a pinned relay every route but `config` answers
  403 `enterprise_mode`, and a page from another relay kept from before the
  mode came on is refused the same way, as the sharing side's groups are.
- The key stays in this server's store from the moment the link is pasted;
  the client knows the page by `receivedId`. The PIN is never kept: opening
  keeps `auth` and the AES key bytes derived from it (`deriveShareSecrets`,
  equal to what `deriveShareKeys` derives). No response carries any of them.
- `<dataDir>/received-pages/<id>.json` (`0600` in a `0700` directory) holds
  the record, `<id>.html` the decrypted document. The id hashes the relay
  base and the share id, so the same link finds the same page. At most 100
  records; past that, the least recently touched go with their documents.
- A relay reply is a share state only with a status its route answers with
  and a body that parses as one; a 5xx, a proxy's page or a malformed body is
  a failed read and changes nothing kept. No relay call, on either side,
  follows a redirect (`redirect: 'error'`): the signed body, the PIN proof and
  the sealed answer go to the relay the link or group names and nowhere else.
- One answer per page: an answer sent from here stays the record's state,
  whatever the relay reports later (the author's collection deletes the
  relay's copy).
- The source text is cut at 200,000 characters on both sides; the agent
  never gets a page past that.

## Decisions

### Why the chat builds the document and the server only seals it

The renderer of `ui` pages and the bootstrap of HTML pages live in packages/ui,
and the link and PIN are useless without the card anyway. Building the
document on the server would need a second copy of that renderer.

### Why the answer arrives as a steered message and not as the call's result

The person may answer days later. The call returns at once, and the answer
wakes the session the way a dispatched session's result or a workflow report
does (`../dispatch-results/`, `../workflows/`), so the agent's turn is never held.

### Why the envelope says the identity is not verified

The label is the name the user gave the agent; whoever holds the link and PIN
can answer. The message tells the agent to treat the content as that person's
answer and as data, not instructions, and keeps `verified="false"` for the day
accounts can verify it.

### Why the group keeps the relay it was made on

A share lives on one relay. Polling and closing it on whatever relay the
settings name later would lose it, so the HTTP origin is fixed at creation.

### Why the recipient's relay calls go through the server and not the browser

The relay sends no CORS headers, so the app could not call it from a page
anyway, and the enterprise policy has to hold where the request leaves this
machine. The server also keeps the key, so a pasted link never sits in a
draft or in the client's storage.

### Why the record keeps derived key material and not the PIN

The answer can come days after the PIN was typed. Keeping `auth` and the
AES key lets the page answer without asking again; the PIN alone with the
link would open the share anywhere, while these two are useless for any other
share.

### Why shares are polled and not only pushed

The nudge reaches only a host with a live private relay control socket, which
most installs do not run. Polling once a minute while something is open costs
one request per relay, and the relay's own state is authoritative either way.

## Runtime parity

- Web and desktop with a managed OpenCode: available (the agent tool exists only there).
- VS Code and an external OpenCode: the agent tool is not injected, so no share is ever made.
- Hosted and Capacitor mobile: the card and its routes work through the server
  they are connected to, relayed or direct; nothing runs in the client.
- Receiving: web, desktop and both mobile shells through their server; the
  phone opens a page full screen. VS Code has no OpenChamber server, so a
  link stays plain text there.
