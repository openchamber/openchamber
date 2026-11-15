# Sharing several messages

## Ownership

This module lets a chat select prompts and answers and share them as one image or as Markdown. It owns what a selectable unit is (`selectableUnits.ts`), how the selection is joined into Markdown (`selectionMarkdown.ts`) and drawn into an image (`selectionExport.ts`), the bar that stands in for the composer (`MessageSelectionBar.tsx`), the checkbox beside a unit (`MessageSelectionMark.tsx`) and the click handling on the transcript (`useMessageSelectionClicks.ts`).

The selection itself is `@/stores/useMessageSelectionStore`. Ending it when the column shows another session, and on Escape, is `@/hooks/useMessageSelectionLifetime`. Drawing and saving the PNG through each runtime is `message/imageExport.ts` (`saveMessageImageExport`), shared with the one-answer "Save as image". The look of the mode (gutter, tint, what steps back) is in `styles/typography.css`, under the `data-message-selecting` attribute that `ChatContainer` puts on the transcript.

## Invariants

- A unit is a turn's prompt (`prompt:<turnId>`) or its whole answer (`answer:<turnId>`): the text of every assistant message of the turn, in order, without tool output or reasoning. The keys come from the same grouping the timeline uses: `attachSyntheticContext` first, which folds the quotes, comments and other context sent as their own synthetic messages into the prompt, then `projectTurnRecords` with `mergeHiddenUserTurns`. A prompt's text is `formatMessageText` of the folded prompt, as the session export writes it, so a prompt that is only a quote with a comment still has text and its quote comes along.
- One selection exists at a time, for one session. It starts from a message's menu with that message selected, and ends on Cancel, Escape, a successful export, or when the column shows another session.
- An export holds every selected unit or none. Loaded records are read first; when one is missing the complete history is loaded; a unit that is gone from the session is deselected with a toast, and nothing is exported.
- A save dialog or share sheet the user dismissed is not an error: the selection stays as it was and no toast shows.
- Joined Markdown binds nothing across messages: each message's reference links and images become inline ones, its definitions are dropped, and its footnotes get a prefix of their own. Each text part is isolated on its own, as the transcript renders each part on its own.
- The image draws each unit the way the transcript shows it: a prompt in the user bubble, an answer through `renderMarkdownForExport` (UI blocks included once that renderer draws them), with the model's name under it.

## Decisions

### Why a prompt and a whole answer, and not single messages

What people share is an exchange. An answer is spread over several assistant messages with tool calls between them, and the turn footer already copies and saves the whole answer that way, so a unit is what the footer acts on.

### Why the checkbox subscribes per unit, and not a prop through the transcript

Message rows are memoized and can be hundreds. Each checkbox reads its own key from the store, so a click re-renders the one or two marks that changed. An answer cut into several rows or messages shows one checkbox, on the first text part of the turn (`opensAnswerText`); its other parts carry a hidden mark so they take the tint too.

### Why clicks are caught on the transcript

The whole prompt or answer is the target, as in a messenger. A capture handler on the transcript toggles the unit and stops the click, so links, code buttons and the text selection menu inside it stay still; text selection is off in the mode for the same reason. The checkbox is still a real control for the keyboard.

### Why the column grows its start padding only by what is missing

The checkboxes stand in a gutter before the text. On a wide chat the space beside the column already holds it and nothing moves; on a narrow one (a phone, a split column) the padding grows by the difference, computed from the transcript width as the column's own padding is.

### Why the bar replaces the composer inside ChatInput

The comment mode on phones does the same: the draft lives in ChatInput's state, so it is back untouched when the bar goes, and the permission and form docks stay where they are. A read-only chat has no ChatInput, so `ChatContainer` puts the bar where the read-only banner would be.

### Why references are inlined, and not renamed per message

Renaming labels has to write a label back in Markdown's escaping rules, and a label with escaped brackets (`[text][a\[b]`) broke the links and images of an earlier attempt. Inlining reads the destination from the parsed definition and keeps the link text as written, so no label is ever written again.

### Why the image is drawn from the records, and not cloned from the screen

A selection can reach rows the virtualized list has not mounted, and answers under a folded Activity. Building the source from the text, as the whole-turn image already does, draws every unit the same way wherever the user scrolled.

### Why a successful export ends the selection

Sharing is the end of the task, and the composer coming back confirms it. Copying and saving the same selection takes a second start from the menu.
