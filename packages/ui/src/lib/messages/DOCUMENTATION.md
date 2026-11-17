# Message helpers

## Ownership

This module owns attached-context encoding and read-back, message-derived model choices, error classification, reply selection, attachment targets, and shared chip representations. Composer stores own editable drafts and picker selections; chat components own rendering, and runtime APIs own delivery and file access.

## Invariants

- Attached context travels as separate synthetic messages with model-facing text and structured metadata. Construction and read-back stay together so the timeline can recover the same context after persistence; message Markdown formatting handles these messages separately from ordinary message parts.
- Context read-back validates server and optimistic metadata before use. Synthetic messages can omit `type`; typed carriers are accepted only for text. The `opencodeComment` mirror survives queued-message round trips.
- Missing source-control providers in older repository issues, change requests, and review context mean GitHub. Legacy GitHub issue/PR and Linear issue payloads and MIME types remain readable. The shared change-request MIME spelling names GitHub but represents every provider.
- A matching neutral link MIME without a provider yields an empty provider string; an unrelated MIME yields null. Callers preserve that distinction when deciding whether an attachment is a reference.
- Code-comment `code` remains the original quote. `changedCode` holds the text at those lines when sent after a change, including an empty string when nothing remains. A diff origin can be absent for uncommitted changes and older messages.
- Whole-file comments use zero for both line numbers, quote no selection, and omit the mirrored selection because the model reads the file itself.
- Guest context data stays opaque for its return trip to the guest and is never rendered. Shared-page model text contains the page as another person's content and excludes the share link, key, and PIN.
- Session references retain a message ID for linked messages with no text so their chips remain discoverable. A session-message excerpt is display text; the attached message is sent whole.
- Linked context uses text fetched or built when attached, supplied by its picker. Reverting or forking restores draft-backed context; linked items stay with their own pickers and have no inline draft form.
- Queued-message previews are display summaries. Editable and delivered text retain the full content; model-context limits preserve content from both ends.
- Reference and session chips share their representation between composer and sent messages. Session chip derivation stays free of I/O so Markdown rendering can use it.
- Attachment citation lookup uses the same case-insensitive basename matching as citation detection, so a rendered citation resolves the attachment it names.
- Recognized errors come only from assistant messages. Decoding accepts live `name`, stored `type`, and older `data.message` shapes; unrecognized payload fields do not become guessed errors.
- Latest-reply selection uses a completed textual answer ending with `stop` in the latest prompt. Streaming messages, tool-call steps, and aborted turns do not count as an answer to read.
- Turn model choices come from assistant replies because OpenCode user messages carry no model. Replies with unloaded or empty parts cannot establish the latest choice. Session-record model choices leave agent selection separate, and field-equal choices retain their previous reference.

## Decisions

### Why stable context wording and not text regenerated from transport metadata

Adding structured metadata preserves the existing model-facing wording so a transport change does not change model behavior. Linked items require their picker's fetched context because their metadata alone cannot recreate it.

### Why an early metadata-key check and not unconditional schema parsing

Most message parts carry neither context key, and both schemas reject undefined. Checking the keys first avoids allocating a ZodError for ordinary parts.

### Why exact interruption details and not an aborted substring

The structured interruption name and whole details `aborted` or `Step interrupted` identify a user stop. A connection or provider stream can also be aborted, so substring matching hides the actual failure and mislabels it as a deliberate stop.

### Why manual model overrides survive conflicting history

A real send updates the selection store to the sent choice. A later conflict with history therefore preserves the user's picker change after the last prompt.

### Why shared claims and not automatic reading in every window

The main window, mini chat, and browser tabs can display the same reply and share origin storage. A Web Lock makes the claim check-and-set atomic so only the claiming window reads; without Web Locks, storage records the claim but cannot guarantee exclusivity.

### Why chip margins and label clipping stay separate

Negative vertical margins keep a chip from increasing the text line's height. Clipping belongs on a normal-line-height label because clipping the chip or a one-em label cuts glyphs; trailing punctuation stays attached through a nowrap wrapper or Markdown's U+2060 word joiner so it cannot wrap onto the next line alone.

### Why by-path attachments open in the file viewer

By-path attachments open from disk through the file viewer regardless of MIME because that is where the server reads their content.

### Why inline PDFs stay labels in VS Code

The app's webview policy excludes the PDF viewer frame and the blob URL read by pdf.js, so an inline PDF has no preview target there.

### Why quote display text differs from the model's quote

The model receives the original Markdown selection, while previews remove Markdown markers for readability. Single `*` and `_` characters remain in display text because they can belong to literal expressions and names.
