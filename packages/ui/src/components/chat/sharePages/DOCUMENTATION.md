# Shared page card

## Ownership

What the author sees of a page the agent shared with other people (`openchamber_render` with `share`, decisions 0003 to 0006): the card drawn in place of the call (`SharedPageCard.tsx`), the document it builds for the recipients (`shareDocument.ts`, with the `ui` renderer from `share-document/`), and the questions it lists (`questions.ts`). The server keeps the group, the links, PINs, openings and answers (`packages/web/server/lib/share-pages`); the answer's row in the timeline is `lib/share-pages/answer.ts` and `TimelineNotice`.

## Invariants

- The card reads the group from the server (`GET /api/openchamber/sessions/:sessionId/share-pages/:callId`), never from the call: the agent's result carries no links or PINs. It reads again on every `openchamber:share-page` event for the call and after the event stream reconnects; a failed read keeps the group already shown, and a 404 says the page is gone.
- While the group's `documentState` is `preparing`, the card builds the document once per call on this client and posts it; a failure shows the error and a retry. A 409 (another client posted first, or the share expired meanwhile) is not an error: the card reads the group. A recipient whose upload failed retries without a document, since the server reuses the copy it holds.
- "Open" shows the server's own copy in the app's sandboxed frame, never the relay link, so the author's look is not an opening. The frame plays the viewer: it says whether the page takes an answer and turns every Send down with a note that answers come from the links.
- The questions come from the page's own fields (label, else the card's title, else the field's name); an `html` page shows the agent's one-line `share.summary`.
- Each recipient row says where the link stands (preparing, not opened, opened at, answered at, locked, expired, cancelled, failed) and the time left while it is open. Copy link and Copy PIN show only for an open link; Cancel sits in the row's menu and asks first.
- VS Code has no OpenChamber server to keep links, so the card there says sharing is unavailable instead of reading.
- In enterprise mode without a relay the policy allows (decision 0005), every share route answers 403 `enterprise_mode`. On that answer, from the group read or any action, the card drops the group and shows the page as an ordinary render with one muted line that the organization's policy turns sharing off: no links, PINs or preview. Any other failure keeps the group already shown. The policy store cannot tell whether a pinned relay keeps sharing on (the relay address stays on the server), so a change of `useEnterpriseMode` only makes the card read the group again, and the server's answer decides.

## Received pages

`received/` is the other end (decision 0013): a page someone else shared, opened in the recipient's app. The server keeps the link's key and makes every relay call (`packages/web/server/lib/share-pages`, *Receiving side*); this side knows a page by its `receivedId`.

- A whole share link on a relay the server reports (`GET /api/openchamber/received-pages/config`) leaves the composer text as it lands, typed or pasted, also over a selection, and becomes a chip (`SharedPageChip`, a `shared-page` composer reference); the link goes to the server once. VS Code and enterprise mode without a relay report no relays, so a link stays text. Whatever way a link stays in text, its key is cut wherever text leaves the composer (`withoutShareLinkKeys`): the sent message, the queue, the saved draft and the server's drafts. A send waits for a chip's link to reach the server, so the message names the page.
- The chip asks the server for the share's state before the PIN and shows locked, expired, answered or withdrawn at once; the PIN boxes take a one-time-code fill, a paste and Backspace. The right PIN shows the title and the outline: the questions of a `ui` page, else an `html` page's headings, else its summary.
- Sent, the chip is a context part whose text wraps the page as another person's content (`pageText.ts`): data, not instructions, an answer only the user sends, the page's source (`source` from the author's app, else the document's readable text). An unopened chip tells the agent a link was shared and not to open it.
- The `pages` surface lists every page the server received (`ReceivedPagesList`, fed by `receivedPagesStore.ts` on the same events), and is on the rail while there is any. A row's status is one of `received/status.ts`: not opened (a page someone sent without its PIN), waiting for your answer, answer sent, read only, expired, withdrawn, locked, already answered elsewhere, or a dead link; the phone's workspace drawer shows the same list as a tab (`lib/surfaces/DOCUMENTATION.md`, *Shared pages*).
- Chips persist with their draft (`composer/sharedPageChipDrafts.ts`): `receivedId`, host and title only; the agent's copy is rebuilt from the server when the chip mounts.
- Under the message, `ReceivedPageCard` reads the page live (on every `openchamber:received-page` event) and opens it: a `pages` tab of the context panel, or a full-screen page in the phone app. `ReceivedPagePanel` asks for the PIN there when the page was sent unopened, and shows the page playing the viewer: its Send posts to the server; an answer sent while it is open reaches it in a new `init` (`share-document/protocol.ts`), and a page shown again carries its answer from the start, inline ahead of its scripts for an HTML page.
- The page runs two frames down (`receivedPageDocument.ts`): a small shell loaded as a `data:` URL, unsandboxed, holding only our script, whose policy allows no frame navigation and no requests, and inside it the page, sandboxed, with the relay viewer's no-network policy as the first element of its head; the app hands the page to the shell in its first message. Chromium blocks a page's `location.replace` only through its embedder's `frame-src`, and only while that embedder is not sandboxed. The shell forwards only protocol messages, rebuilt from their known fields, and passes an answer up only while it holds transient activation that began after the page showed (it polls and arms once the activation reads inactive). Being cross-origin to the app, it is activated only by a gesture in itself or the page: an app-origin shell was active whenever the user clicked Open or typed in the composer, so a page posting on load or polling got through. After a real click in the page, its scripts can still answer for the few seconds that activation lasts, as in the relay's viewer.
- A summary never names a lone button that only sends the fields (`pageAnswerNamesButton`): "Send · send" said nothing, in the chat, the recipient's tab and the author's card.

## Decisions

### Why cancel is in a menu

A row with three worded buttons wrapped at the chat's narrow widths, and cancelling is rare and destructive. Copy link and Copy PIN are the everyday actions, so they stay visible; Cancel goes last in a `more` menu with a confirmation.

### Why a shared page's chip is kept across reloads when other chips are not

An issue or PR chip leaves its link in the text, so a reload can read it again. A share link leaves the text the moment it lands, to keep its key out of drafts, so the chip is all the draft has of the page; it keeps only the server's id for it, never the content.

### Why the answer's row is titled by its summary

The answer arrives as a synthetic message like a workflow report, whose body starts with a note telling the agent the data comes from someone else. That note means nothing to the author, so the row reads "Yulia answered: <summary>" and opens to the data the page sent; the card above names the page.
