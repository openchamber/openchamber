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

## Decisions

### Why cancel is in a menu

A row with three worded buttons wrapped at the chat's narrow widths, and cancelling is rare and destructive. Copy link and Copy PIN are the everyday actions, so they stay visible; Cancel goes last in a `more` menu with a confirmation.

### Why the answer's row is titled by its summary

The answer arrives as a synthetic message like a workflow report, whose body starts with a note telling the agent the data comes from someone else. That note means nothing to the author, so the row reads "Yulia answered: <summary>" and opens to the data the page sent; the card above names the page.
