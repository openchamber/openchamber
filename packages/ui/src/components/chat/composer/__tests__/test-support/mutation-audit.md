# Composer test mutation audit

Counts are executed cases, including parameterized cases. Each experiment ran only the owning test file from packages/ui. Product edits were restored after each run.

| File | Before | Kept | Rewritten | Deleted |
| --- | ---: | ---: | ---: | ---: |
| `__tests__/dictationInsertAndSend.test.ts` | 3 | 0 | 0 | 3 |
| `__tests__/largeTextPaste.test.ts` | 6 | 6 | 0 | 0 |
| `__tests__/largeTextPasteGesture.test.ts` | 29 | 28 | 1 | 0 |
| `__tests__/largeTextPasteOffer.test.ts` | 6 | 6 | 0 | 0 |
| `__tests__/text.test.ts` | 42 | 42 | 0 | 0 |
| `attachments/__tests__/dataTransfer.test.ts` | 18 | 18 | 0 | 0 |
| `attachments/__tests__/filePaths.test.ts` | 33 | 33 | 0 | 0 |
| `attachments/__tests__/inlineMentionAttachments.test.ts` | 20 | 20 | 0 | 0 |
| `comment/__tests__/MobileCommentComposer.keyboard.test.tsx` | 9 | 9 | 0 | 0 |
| `comment/__tests__/mobileCommentDraft.test.ts` | 30 | 30 | 0 | 0 |
| `comment/__tests__/useMobileCommentComposerMode.test.tsx` | 6 | 6 | 0 | 0 |
| `composerReferences.test.ts` | 5 | 5 | 0 | 0 |
| `editor/__tests__/ComposerEditorView.test.ts` | 1 | 0 | 1 | 0 |
| `editor/__tests__/autocorrect.test.ts` | 9 | 8 | 0 | 1 |
| `editor/__tests__/bidi.test.ts` | 4 | 4 | 0 | 0 |
| `editor/__tests__/composerHeightLimit.test.ts` | 9 | 9 | 0 | 0 |
| `editor/__tests__/composerLanguage.test.ts` | 27 | 26 | 0 | 1 |
| `editor/__tests__/documentEdits.test.ts` | 6 | 6 | 0 | 0 |
| `editor/__tests__/dom.test.ts` | 2 | 2 | 0 | 0 |
| `editor/__tests__/hostMouseDown.test.ts` | 5 | 5 | 0 | 0 |
| `editor/__tests__/imeNewline.test.ts` | 16 | 16 | 0 | 0 |
| `editor/__tests__/inputRedirect.test.ts` | 12 | 12 | 0 | 0 |
| `editor/__tests__/iosNativeParagraph.test.ts` | 4 | 4 | 0 | 0 |
| `editor/__tests__/largeTextPaste.integration.test.tsx` | 12 | 12 | 0 | 0 |
| `editor/__tests__/pageNavigation.integration.test.tsx` | 8 | 8 | 0 | 0 |
| `editor/__tests__/theme.test.ts` | 25 | 24 | 0 | 1 |
| `editor/__tests__/valuePropChange.integration.test.tsx` | 3 | 3 | 0 | 0 |
| `editor/__tests__/writebackCompositionGuard.test.ts` | 1 | 0 | 1 | 0 |
| `keyboardPolicy.test.ts` | 58 | 58 | 0 | 0 |
| `language/__tests__/mentions.test.ts` | 38 | 38 | 0 | 0 |
| `language/__tests__/paths.test.ts` | 17 | 17 | 0 | 0 |
| `language/__tests__/prefixTokens.test.ts` | 30 | 30 | 0 | 0 |
| `language/__tests__/tokenize.test.ts` | 28 | 28 | 0 | 0 |
| `language/__tests__/triggers.test.ts` | 35 | 34 | 0 | 1 |
| `linkedReferenceDrafts.test.ts` | 6 | 6 | 0 | 0 |
| `pastedSessionIds.test.ts` | 9 | 9 | 0 | 0 |
| `pendingComposerReferences.test.ts` | 11 | 11 | 0 | 0 |
| `referenceLinks.test.ts` | 8 | 8 | 0 | 0 |
| `sessionReferences.test.ts` | 4 | 4 | 0 | 0 |
| `sharedPageChipDrafts.test.ts` | 2 | 2 | 0 | 0 |
| `state/__tests__/promptHistorySearch.test.ts` | 5 | 5 | 0 | 0 |
| `state/__tests__/useComposerDraft.btwPending.test.ts` | 9 | 8 | 0 | 1 |
| `state/__tests__/useComposerDraft.fork.test.ts` | 7 | 7 | 0 | 0 |
| `state/__tests__/useComposerDraft.retarget.test.ts` | 8 | 8 | 0 | 0 |
| `state/__tests__/useDictationOrigin.test.ts` | 4 | 4 | 0 | 0 |
| `state/__tests__/useDraftTarget.pinnedDirectory.test.tsx` | 4 | 4 | 0 | 0 |
| `state/__tests__/useDraftTarget.refresh.test.tsx` | 2 | 2 | 0 | 0 |
| `state/__tests__/useDraftTarget.worktreeBootstrap.test.tsx` | 1 | 1 | 0 | 0 |
| `state/__tests__/useMessageHistory.test.ts` | 19 | 19 | 0 | 0 |
| `state/__tests__/useMobileViewportPin.test.tsx` | 9 | 9 | 0 | 0 |
| `state/__tests__/usePendingComposerText.slashCommand.test.tsx` | 2 | 2 | 0 | 0 |
| `state/__tests__/usePendingComposerText.test.tsx` | 5 | 5 | 0 | 0 |
| `state/abortShortcutReach.test.ts` | 1 | 1 | 0 | 0 |
| `state/composerInsetReaders.test.ts` | 9 | 9 | 0 | 0 |
| `state/composerTailInset.test.ts` | 6 | 6 | 0 | 0 |
| `state/promptHistorySearchRoute.test.ts` | 1 | 1 | 0 | 0 |
| `submit/__tests__/buildOutgoingMessage.test.ts` | 46 | 44 | 0 | 2 |
| `submit/__tests__/forkCommand.test.ts` | 5 | 5 | 0 | 0 |
| `submit/__tests__/guestCommands.test.ts` | 3 | 3 | 0 | 0 |
| `submit/__tests__/slashCommands.test.ts` | 25 | 25 | 0 | 0 |
| `ui/ComposerActionButtons.test.tsx` | 11 | 11 | 0 | 0 |
| `ui/DraftTargetSelectors.test.tsx` | 3 | 3 | 0 | 0 |
| `ui/LargeTextPasteChoice.test.tsx` | 7 | 7 | 0 | 0 |
| `ui/MobilePillComposer.test.tsx` | 10 | 10 | 0 | 0 |
| `ui/PromptHistorySearchPanel.test.tsx` | 31 | 31 | 0 | 0 |
| `ui/__tests__/ComposerFloatingPanel.test.tsx` | 2 | 2 | 0 | 0 |
| `ui/__tests__/usePlaceholderFitsOneLine.test.tsx` | 4 | 4 | 0 | 0 |

## Validation

- All 66 remaining test files passed in 3 consecutive independent processes per file.
- The fake-clock largeTextPasteGesture.test.ts file passed another 20 consecutive independent runs.
- The requested product-only diff against origin/bohdan/dev was empty.
- Scoped oxlint exited with code 0.

## Invariants no longer tested

- Dictation insert-and-send reads the live draft and submits the composed transcript.
- The editor serializes reference-marked source text unchanged.
- CodeMirror upstream period-revert and platform-detection internals match the autocorrect workaround.
- Composer send and queue wiring uses ordinary-only queue content and captured configuration.
- Composer send and queue gates count linked text and filter linked context before submission.
- The compiled iOS selection extension contains no native-selection fallback.
- The command palette rejects a caret beyond its command line independently of its space guard.
- Persisted legacy BTW placeholder text is ignored when restoration reads storage.

## Still waits on real time

- state/__tests__/useComposerDraft.fork.test.ts: persists a replay even when its text equals the outgoing source draft. It waits 550 ms. Dropping the forced persistence call made it red, so it remains unchanged.


## __tests__/dictationInsertAndSend.test.ts

- `__tests__/dictationInsertAndSend.test.ts:19` dictation insert-and-send composition > appends the transcript to the typed draft kept in the ref: `input/useComposerDictation.ts`. Deleted after 2 green mutations: `const next = appendInlineText(composerText.get(), text);` to `const next = appendInlineText(composerText.get(), '');`; `handleSubmitRef.current({ presetText: next })` to `handleSubmitRef.current({ presetText: '' })`.
- `__tests__/dictationInsertAndSend.test.ts:26` dictation insert-and-send composition > an unmounted-editor read (empty string) is what used to drop the draft: `input/useComposerDictation.ts`. Deleted after 2 green mutations: `const next = appendInlineText(composerText.get(), text);` to `const next = appendInlineText(composerText.get(), '');`; `handleSubmitRef.current({ presetText: next })` to `handleSubmitRef.current({ presetText: '' })`.
- `__tests__/dictationInsertAndSend.test.ts:41` dictation insert-and-send composition > dictating into an empty composer still sends just the transcript: `input/useComposerDictation.ts`. Deleted after 2 green mutations: `const next = appendInlineText(composerText.get(), text);` to `const next = appendInlineText(composerText.get(), '');`; `handleSubmitRef.current({ presetText: next })` to `handleSubmitRef.current({ presetText: '' })`.

## __tests__/largeTextPaste.test.ts

- `__tests__/largeTextPaste.test.ts:11` large text paste helpers > treats short text as not large: `largeTextPaste.ts`. Kept unchanged; red after `text.length >= charThreshold` to `!(text.length >= charThreshold)`.
- `__tests__/largeTextPaste.test.ts:16` large text paste helpers > treats empty and whitespace-only pastes as not large: `largeTextPaste.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPaste.test.ts:21` large text paste helpers > detects pastes at the character threshold: `largeTextPaste.ts`. Kept unchanged; red after `true` to `false`.
- `__tests__/largeTextPaste.test.ts:27` large text paste helpers > detects pastes at the line threshold: `largeTextPaste.ts`. Kept unchanged; red after `1` to `0`.
- `__tests__/largeTextPaste.test.ts:33` large text paste helpers > honors custom thresholds: `largeTextPaste.ts`. Kept unchanged; red after `1` to `0`.
- `__tests__/largeTextPaste.test.ts:39` large text paste helpers > creates a text/plain file with the given name: `largeTextPaste.ts`. Kept unchanged; red after `'text/plain'` to `''`.

## __tests__/largeTextPasteGesture.test.ts

- `__tests__/largeTextPasteGesture.test.ts:40` large text double-paste gesture with real CodeMirror edits > Ctrl+V converts with a Cyrillic key value: `largeTextPaste.ts`. Kept unchanged; red after `replace(candidate.from, candidate.to, citation);` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:40` large text double-paste gesture with real CodeMirror edits > Cmd+V converts with a Cyrillic key value: `largeTextPaste.ts`. Kept unchanged; red after `replace(candidate.from, candidate.to, citation);` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:49` large text double-paste gesture with real CodeMirror edits > Latin layouts keep the character-based meaning when V moves to another physical key: `largeTextPaste.ts`. Kept unchanged; red after `true` to `false`.
- `__tests__/largeTextPasteGesture.test.ts:55` large text double-paste gesture with real CodeMirror edits > a physical V key producing another Latin character does not arm conversion: `largeTextPaste.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/largeTextPasteGesture.test.ts:61` large text double-paste gesture with real CodeMirror edits > a Cyrillic key release without a delivered paste cannot authorize a later menu paste: `largeTextPaste.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `__tests__/largeTextPasteGesture.test.ts:68` large text double-paste gesture with real CodeMirror edits > first paste inserts immediately; second replaces only its measured CRLF range after acceptance: `largeTextPaste.ts`. Kept unchanged; red after `1` to `0`.
- `__tests__/largeTextPasteGesture.test.ts:88` large text double-paste gesture with real CodeMirror edits > does not convert at 1000ms: `largeTextPaste.ts`. Kept unchanged; red after ` < ` to ` >= `.
- `__tests__/largeTextPasteGesture.test.ts:88` large text double-paste gesture with real CodeMirror edits > does not convert at 1001ms: `largeTextPaste.ts`. Kept unchanged; red after ` < ` to ` >= `.
- `__tests__/largeTextPasteGesture.test.ts:94` large text double-paste gesture with real CodeMirror edits > different clipboard text stays inline: `largeTextPaste.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `__tests__/largeTextPasteGesture.test.ts:100` large text double-paste gesture with real CodeMirror edits > a moved selection cannot convert even without an invalidation callback: `largeTextPaste.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/largeTextPasteGesture.test.ts:105` large text double-paste gesture with real CodeMirror edits > stale document snapshot cannot authorize destructive replacement: `largeTextPaste.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPasteGesture.test.ts:114` large text double-paste gesture with real CodeMirror edits > releasing V without a paste cannot authorize a later menu paste: `largeTextPaste.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `__tests__/largeTextPasteGesture.test.ts:119` large text double-paste gesture with real CodeMirror edits > key repeat cannot convert or arm the next paste: `largeTextPaste.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/largeTextPasteGesture.test.ts:124` large text double-paste gesture with real CodeMirror edits > context-menu and touch pastes never convert or arm a candidate: `largeTextPaste.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > edit invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after `null` to `[]`.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > selection invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after `this.state = { kind: 'idle' };` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > blur invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after `this.state = { kind: 'idle' };` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > scope invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > mode invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after `this.state = { kind: 'idle' };` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:129` large text double-paste gesture with real CodeMirror edits > unmount invalidates conversion: `largeTextPaste.ts`. Kept unchanged; red after `this.state = { kind: 'idle' };` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:137` large text double-paste gesture with real CodeMirror edits > non-paste keyboard movement invalidates even when caret returns: `largeTextPaste.ts`. Kept unchanged; red after `this.invalidate();` to `;`.
- `__tests__/largeTextPasteGesture.test.ts:143` large text double-paste gesture with real CodeMirror edits > attachment reject retains inline text: `largeTextPaste.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/largeTextPasteGesture.test.ts:143` large text double-paste gesture with real CodeMirror edits > attachment throw retains inline text: `largeTextPaste.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `__tests__/largeTextPasteGesture.test.ts:152` large text double-paste gesture with real CodeMirror edits > async success after edit never replaces newer text or draft: `largeTextPaste.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPasteGesture.test.ts:152` large text double-paste gesture with real CodeMirror edits > async success after scope never replaces newer text or draft: `largeTextPaste.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/largeTextPasteGesture.test.ts:152` large text double-paste gesture with real CodeMirror edits > async success after blur never replaces newer text or draft: `largeTextPaste.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/largeTextPasteGesture.test.ts:164` large text double-paste gesture with real CodeMirror edits > a 100K character insertion can be converted once: `largeTextPaste.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPasteGesture.test.ts:171` large text double-paste gesture with real CodeMirror edits > short text and whitespace do not arm conversion: `largeTextPaste.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/largeTextPasteGesture.test.ts:177` large text double-paste gesture with real CodeMirror edits > candidate expires and releases the clipboard after 1000ms: `largeTextPaste.ts`. Rewritten; red after `setTimeout(() => this.invalidate(), DOUBLE_PASTE_WINDOW_MS)` to `setTimeout(() => {}, DOUBLE_PASTE_WINDOW_MS)`.

## __tests__/largeTextPasteOffer.test.ts

- `__tests__/largeTextPasteOffer.test.ts:10` large text paste offer state > begin allocates the next offer id: `largeTextPasteOffer.ts`. Kept unchanged; red after `1` to `0`.
- `__tests__/largeTextPasteOffer.test.ts:15` large text paste offer state > resolve accepts a matching active offer and invalidates it: `largeTextPasteOffer.ts`. Kept unchanged; red after `true` to `false`.
- `__tests__/largeTextPasteOffer.test.ts:23` large text paste offer state > resolve rejects a superseded offer without advancing: `largeTextPasteOffer.ts`. Kept unchanged; red after `false` to `true`.
- `__tests__/largeTextPasteOffer.test.ts:31` large text paste offer state > second resolve after accept is rejected (double-apply guard): `largeTextPasteOffer.ts`. Kept unchanged; red after `true` to `false`.
- `__tests__/largeTextPasteOffer.test.ts:41` large text paste offer state > begin then resolve of the old id is rejected: `largeTextPasteOffer.ts`. Kept unchanged; red after `1` to `0`.
- `__tests__/largeTextPasteOffer.test.ts:52` large text paste offer state > only an explicit choice on an active offer restores focus: `largeTextPasteOffer.ts`. Kept unchanged; red after `false` to `true`.

## __tests__/text.test.ts

- `__tests__/text.test.ts:15` appendWithLineBreaks > separates the block with a blank line and ends with one: `text.ts`. Kept unchanged; red after `base.endsWith('\n')` to `!(base.endsWith('\n'))`.
- `__tests__/text.test.ts:19` appendWithLineBreaks > does not stack separators that are already there: `text.ts`. Kept unchanged; red after `base.endsWith('\n')` to `!(base.endsWith('\n'))`.
- `__tests__/text.test.ts:24` appendWithLineBreaks > an empty base needs no separator: `text.ts`. Kept unchanged; red after `!base` to `!(!base)`.
- `__tests__/text.test.ts:28` appendWithLineBreaks > trailing breaks in the inserted block are normalized, not doubled: `text.ts`. Kept unchanged; red after `base.endsWith('\n')` to `!(base.endsWith('\n'))`.
- `__tests__/text.test.ts:35` appendInlineText > joins with a single space and leaves the caret room: `text.ts`. Kept unchanged; red after `/[\s\n]$/.test(base)` to `!(/[\s\n]$/.test(base))`.
- `__tests__/text.test.ts:39` appendInlineText > does not double an existing space: `text.ts`. Kept unchanged; red after `/[\s\n]$/.test(base)` to `!(/[\s\n]$/.test(base))`.
- `__tests__/text.test.ts:44` appendInlineText > an empty base yields just the text: `text.ts`. Kept unchanged; red after `\`${nextTrimmed} \`` to `''`.
- `__tests__/text.test.ts:48` appendInlineText > blank additions are ignored: `text.ts`. Kept unchanged; red after `!nextTrimmed` to `!(!nextTrimmed)`.
- `__tests__/text.test.ts:53` appendInlineText > the addition is trimmed before joining: `text.ts`. Kept unchanged; red after `/[\s\n]$/.test(base)` to `!(/[\s\n]$/.test(base))`.
- `__tests__/text.test.ts:59` withLeadingSlashCommand > the draft becomes the argument: `text.ts`. Kept unchanged; red after `\`${command} ${draft}\`` to `''`.
- `__tests__/text.test.ts:64` withLeadingSlashCommand > an empty draft leaves room for the argument: `text.ts`. Kept unchanged; red after `\`${command} \`` to `''`.
- `__tests__/text.test.ts:69` withLeadingSlashCommand > a draft that already starts with the command keeps its text: `text.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `__tests__/text.test.ts:74` withLeadingSlashCommand > another command or a longer name is part of the argument: `text.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/text.test.ts:81` withInlineInsertionBoundaries > pads between two words: `text.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `__tests__/text.test.ts:85` withInlineInsertionBoundaries > adds nothing at the very start or end: `text.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `__tests__/text.test.ts:89` withInlineInsertionBoundaries > respects whitespace already present: `text.ts`. Kept unchanged; red after `         && ` to ` \|\| `.
- `__tests__/text.test.ts:93` withInlineInsertionBoundaries > no space after an opening bracket: `text.ts`. Kept unchanged; red after `0` to `1`.
- `__tests__/text.test.ts:98` withInlineInsertionBoundaries > no space before a closing bracket or sentence punctuation: `text.ts`. Kept unchanged; red after `0` to `1`.
- `__tests__/text.test.ts:104` withInlineInsertionBoundaries > empty content stays empty: `text.ts`. Kept unchanged; red after `!content` to `!(!content)`.
- `__tests__/text.test.ts:110` buildImagePasteInsertion > a citation pasted alone is the whole insertion: `text.ts`. Kept unchanged; red after `!pastedText` to `!(!pastedText)`.
- `__tests__/text.test.ts:114` buildImagePasteInsertion > text pasted with the image keeps the citation after it: `text.ts`. Kept unchanged; red after `/\s$/.test(pastedText)` to `!(/\s$/.test(pastedText))`.
- `__tests__/text.test.ts:118` buildImagePasteInsertion > an existing trailing space is not doubled: `text.ts`. Kept unchanged; red after `/\s$/.test(pastedText)` to `!(/\s$/.test(pastedText))`.
- `__tests__/text.test.ts:124` shouldWrapSelectionAsLink > a URL pasted over selected text becomes a link: `text.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `__tests__/text.test.ts:129` shouldWrapSelectionAsLink > non-URLs are pasted normally: `text.ts`. Kept unchanged; red after `         && ` to ` \|\| `.
- `__tests__/text.test.ts:134` shouldWrapSelectionAsLink > a URL containing whitespace is not one: `text.ts`. Kept unchanged; red after `         && ` to ` \|\| `.
- `__tests__/text.test.ts:138` shouldWrapSelectionAsLink > an empty or blank selection has nothing to wrap: `text.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `__tests__/text.test.ts:143` shouldWrapSelectionAsLink > a selection that is already a link is not nested: `text.ts`. Kept unchanged; red after `         && ` to ` \|\| `.
- `__tests__/text.test.ts:149` getMarkdownAutoPairEdit > completes a fenced block with the caret on the middle line: `text.ts`. Kept unchanged; red after `0` to `1`.
- `__tests__/text.test.ts:159` getMarkdownAutoPairEdit > completes a fence at the start of any line: `text.ts`. Kept unchanged; red after `2` to `1`.
- `__tests__/text.test.ts:169` getMarkdownAutoPairEdit > does not complete two backticks in the middle of a line: `text.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `__tests__/text.test.ts:173` getMarkdownAutoPairEdit > wraps selected text and keeps the text selected: `text.ts`. Kept unchanged; red after ` + ` to ` - `.
- `__tests__/text.test.ts:185` getOrderedListContinuationEdit > continues a numbered item with the next number at the same indentation: `text.ts`. Kept unchanged; red after `2` to `1`.
- `__tests__/text.test.ts:195` getOrderedListContinuationEdit > keeps the delimiter the user typed: `text.ts`. Kept unchanged; red after `2` to `1`.
- `__tests__/text.test.ts:200` getOrderedListContinuationEdit > an item with no text ends the list by clearing its line: `text.ts`. Kept unchanged; red after `4` to `3`.
- `__tests__/text.test.ts:221` getOrderedListContinuationEdit > continues when the item has trailing text after its marker: `text.ts`. Kept unchanged; red after `2` to `1`.
- `__tests__/text.test.ts:227` getOrderedListContinuationEdit > only the line end counts: `text.ts`. Kept unchanged; red after `selectionStart !== lineEnd` to `!(selectionStart !== lineEnd)`.
- `__tests__/text.test.ts:232` getOrderedListContinuationEdit > a selection or a line that is not a list is left alone: `text.ts`. Kept unchanged; red after ` + ` to ` - `.
- `__tests__/text.test.ts:242` fenced code > getOrderedListContinuationEdit > a numbered line inside a closed fence stays a plain newline: `text.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/text.test.ts:252` fenced code > getOrderedListContinuationEdit > an unclosed fence runs to the end of the prompt: `text.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/text.test.ts:257` fenced code > getOrderedListContinuationEdit > only a matching fence closes the block: `text.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/text.test.ts:263` fenced code > getOrderedListContinuationEdit > an empty item inside a fence stays a plain newline: `text.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `__tests__/text.test.ts:267` fenced code > getOrderedListContinuationEdit > a real list after a closed fence continues: `text.ts`. Kept unchanged; red after `2` to `1`.

## attachments/__tests__/dataTransfer.test.ts

- `attachments/__tests__/dataTransfer.test.ts:36` hasDraggedFiles > real files are recognized: `attachments/dataTransfer.ts`. Kept unchanged; red after `0` to `1`.
- `attachments/__tests__/dataTransfer.test.ts:40` hasDraggedFiles > a declared file-bearing type is enough: `attachments/dataTransfer.ts`. Kept unchanged; red after `true` to `false`.
- `attachments/__tests__/dataTransfer.test.ts:46` hasDraggedFiles > an internal file-tree drag is recognized: `attachments/dataTransfer.ts`. Kept unchanged; red after `true` to `false`.
- `attachments/__tests__/dataTransfer.test.ts:50` hasDraggedFiles > a VS Code tree type is recognized by prefix: `attachments/dataTransfer.ts`. Kept unchanged; red after `true` to `false`.
- `attachments/__tests__/dataTransfer.test.ts:55` hasDraggedFiles > type matching is case-insensitive: `attachments/dataTransfer.ts`. Kept unchanged; red after `true` to `false`.
- `attachments/__tests__/dataTransfer.test.ts:59` hasDraggedFiles > falls back to scanning payloads when the types say nothing useful: `attachments/dataTransfer.ts`. Kept unchanged; red after `0` to `1`.
- `attachments/__tests__/dataTransfer.test.ts:66` hasDraggedFiles > dragged text is not a file drag: `attachments/dataTransfer.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `attachments/__tests__/dataTransfer.test.ts:73` hasDraggedFiles > a missing transfer is not a file drag: `attachments/dataTransfer.ts`. Kept unchanged; red after `false` to `true`.
- `attachments/__tests__/dataTransfer.test.ts:78` hasDraggedFiles > an unreadable payload does not abort the scan: `attachments/dataTransfer.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `attachments/__tests__/dataTransfer.test.ts:87` collectDroppedFiles > reads the files list: `attachments/dataTransfer.ts`. Kept unchanged; red after `0` to `1`.
- `attachments/__tests__/dataTransfer.test.ts:92` collectDroppedFiles > falls back to the item list: `attachments/dataTransfer.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/dataTransfer.test.ts:98` collectDroppedFiles > non-file items are skipped: `attachments/dataTransfer.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/dataTransfer.test.ts:104` collectDroppedFiles > a file item that yields nothing is skipped: `attachments/dataTransfer.ts`. Kept unchanged; red after `.filter((file): file is File => Boolean(file))` to ``.
- `attachments/__tests__/dataTransfer.test.ts:108` collectDroppedFiles > an empty or missing transfer yields nothing: `attachments/dataTransfer.ts`. Kept unchanged; red after `[]` to `null`.
- `attachments/__tests__/dataTransfer.test.ts:115` collectDroppedFileUris > reads paths out of a VS Code payload: `attachments/dataTransfer.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `attachments/__tests__/dataTransfer.test.ts:121` collectDroppedFileUris > the same path across several types is returned once: `attachments/dataTransfer.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `attachments/__tests__/dataTransfer.test.ts:127` collectDroppedFileUris > a payload with no paths yields nothing: `attachments/dataTransfer.ts`. Kept unchanged; red after `parseDroppedFileReferences(rawPayload)` to `[rawPayload]`.
- `attachments/__tests__/dataTransfer.test.ts:133` collectDroppedFileUris > a transfer without getData yields nothing: `attachments/dataTransfer.ts`. Kept unchanged; red after `[]` to `null`.

## attachments/__tests__/filePaths.test.ts

- `attachments/__tests__/filePaths.test.ts:15` encodeFilePath > encodes segments but keeps separators: `attachments/filePaths.ts`. Kept unchanged; red after `index === 1 && /^[A-Za-z]:$/.test(segment)` to `!(index === 1 && /^[A-Za-z]:$/.test(segment))`.
- `attachments/__tests__/filePaths.test.ts:19` encodeFilePath > backslashes become forward slashes: `attachments/filePaths.ts`. Kept unchanged; red after `let normalized = filepath.replace(/\\/g, '/');` to `let normalized = filepath.replace(/\\/g, '');`.
- `attachments/__tests__/filePaths.test.ts:23` encodeFilePath > a Windows drive letter is preserved unencoded: `attachments/filePaths.ts`. Kept unchanged; red after `let normalized = filepath.replace(/\\/g, '/');` to `let normalized = filepath.replace(/\\/g, '');`.
- `attachments/__tests__/filePaths.test.ts:27` encodeFilePath > special characters in a name are encoded: `attachments/filePaths.ts`. Kept unchanged; red after `index === 1 && /^[A-Za-z]:$/.test(segment)` to `!(index === 1 && /^[A-Za-z]:$/.test(segment))`.
- `attachments/__tests__/filePaths.test.ts:33` toServerFileUrl > wraps a plain path: `attachments/filePaths.ts`. Kept unchanged; red after `\`file://${encodeFilePath(normalized)}\`` to `''`.
- `attachments/__tests__/filePaths.test.ts:37` toServerFileUrl > an existing file URL is passed through unchanged: `attachments/filePaths.ts`. Kept unchanged; red after `normalized` to `''`.
- `attachments/__tests__/filePaths.test.ts:42` toServerFileUrl > a Windows path becomes a valid file URL: `attachments/filePaths.ts`. Kept unchanged; red after `1` to `0`.
- `attachments/__tests__/filePaths.test.ts:48` isLikelyAbsolutePath > recognizes posix, UNC and Windows roots: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:55` isLikelyAbsolutePath > relative paths are not absolute: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:62` toLikelyFileDropReference > accepts an absolute path and a file URL: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:67` toLikelyFileDropReference > strips surrounding quotes and whitespace: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:71` toLikelyFileDropReference > rejects relative paths, prose and empty input: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:77` toLikelyFileDropReference > rejects a multi-line value, which is a document not a path: `attachments/filePaths.ts`. Kept unchanged; red after `null` to `[]`.
- `attachments/__tests__/filePaths.test.ts:83` parseDroppedFileReferences > reads a single path: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:87` parseDroppedFileReferences > reads a newline-separated URI list: `attachments/filePaths.ts`. Kept unchanged; red after `trimmed` to `''`.
- `attachments/__tests__/filePaths.test.ts:92` parseDroppedFileReferences > finds paths nested inside a JSON payload: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:97` parseDroppedFileReferences > duplicates across passes are collapsed: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:101` parseDroppedFileReferences > a payload with no paths yields nothing: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:106` parseDroppedFileReferences > deeply buried paths beyond the depth bound are not searched forever: `attachments/filePaths.ts`. Kept unchanged; red after `return value.startsWith('/')` to `return !value.startsWith('/')`.
- `attachments/__tests__/filePaths.test.ts:114` normalizeDroppedPath > a plain path is returned as-is: `attachments/filePaths.ts`. Kept unchanged; red after `input` to `''`.
- `attachments/__tests__/filePaths.test.ts:118` normalizeDroppedPath > a file URL is decoded back to a path: `attachments/filePaths.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/filePaths.test.ts:122` normalizeDroppedPath > a Windows file URL drops the slash before the drive letter: `attachments/filePaths.ts`. Kept unchanged; red after `1` to `0`.
- `attachments/__tests__/filePaths.test.ts:126` normalizeDroppedPath > a malformed file URL still yields something usable: `attachments/filePaths.ts`. Kept unchanged; red after `stripped` to `''`.
- `attachments/__tests__/filePaths.test.ts:132` normalizePath > trims and drops a trailing separator: `packages/ui/src/lib/pathNormalization.ts`. Kept unchanged; red after `replaced.replace(/\/+$/, "")` to `replaced.replace(/\/+$/, "/")`.
- `attachments/__tests__/filePaths.test.ts:137` normalizePath > backslashes become forward slashes: `packages/ui/src/lib/pathNormalization.ts`. Kept unchanged; red after `.replace(/\\/g, "/")` to `.replace(/\\/g, "")`.
- `attachments/__tests__/filePaths.test.ts:141` normalizePath > the root keeps its slash: `packages/ui/src/lib/pathNormalization.ts`. Kept unchanged; red after `if (replaced === "/") return "/";` to `if (replaced === "/") return '';`.
- `attachments/__tests__/filePaths.test.ts:145` normalizePath > blank and non-string input yield null: `packages/ui/src/lib/pathNormalization.ts`. Kept unchanged; red after `if (typeof value !== "string") return null;` to `if (typeof value !== "string") return '';`.
- `attachments/__tests__/filePaths.test.ts:154` toProjectRelativeMentionPath > strips the project root: `attachments/filePaths.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/filePaths.test.ts:158` toProjectRelativeMentionPath > tolerates a trailing slash on the root: `attachments/filePaths.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/filePaths.test.ts:162` toProjectRelativeMentionPath > a path outside the root stays absolute: `attachments/filePaths.ts`. Kept unchanged; red after `normalizedAbsolutePath.startsWith(rootWithSlash)` to `!(normalizedAbsolutePath.startsWith(rootWithSlash))`.
- `attachments/__tests__/filePaths.test.ts:166` toProjectRelativeMentionPath > a sibling directory sharing a prefix is not treated as inside: `attachments/filePaths.ts`. Kept unchanged; red after `normalizedAbsolutePath.startsWith(rootWithSlash)` to `!(normalizedAbsolutePath.startsWith(rootWithSlash))`.
- `attachments/__tests__/filePaths.test.ts:170` toProjectRelativeMentionPath > the root itself is returned unchanged: `attachments/filePaths.ts`. Kept unchanged; red after `normalizedAbsolutePath` to `''`.
- `attachments/__tests__/filePaths.test.ts:174` toProjectRelativeMentionPath > with no root the path is left alone: `attachments/filePaths.ts`. Kept unchanged; red after `normalizedAbsolutePath` to `''`.

## attachments/__tests__/inlineMentionAttachments.test.ts

- `attachments/__tests__/inlineMentionAttachments.test.ts:45` findMissingPaths > names only the paths a listing proves absent: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `missing` to `''`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:64` filterMissingInlineAttachments > keeps everything when no inline attachments exist: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `     && ` to ` \|\| `.
- `attachments/__tests__/inlineMentionAttachments.test.ts:75` filterMissingInlineAttachments > keeps attachments whose files exist, listing each directory once: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `attachments/__tests__/inlineMentionAttachments.test.ts:92` filterMissingInlineAttachments > drops only the missing inline attachment and names it: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `attachments/__tests__/inlineMentionAttachments.test.ts:107` filterMissingInlineAttachments > fails open when the listing errors: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `parentMissing` to `!(parentMissing)`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:117` filterMissingInlineAttachments > drops mentions whose parent directory does not exist and keeps checking the rest: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `attachments/__tests__/inlineMentionAttachments.test.ts:135` filterMissingInlineAttachments > a failing listing keeps only its own directory unchecked: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `0` to `1`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:151` filterMissingInlineAttachments > matches directories and paths that differ only in case: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `attachments/__tests__/inlineMentionAttachments.test.ts:181` isMentionAlreadyAttached > recognizes a replayed file whose mention is a plain path: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:187` isMentionAlreadyAttached > compares a Windows drive URL and its plain path: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:193` isMentionAlreadyAttached > decodes an encoded URL: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:199` isMentionAlreadyAttached > keeps distinct case-sensitive paths: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:206` isMentionAlreadyAttached > keeps a same-named file from another directory: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:213` isMentionAlreadyAttached > keeps a same-named converted image without a known source path: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:222` isMentionAlreadyAttached > recognizes a converted image only when its source path is retained: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:233` isMentionAlreadyAttached > keeps a same-named local upload and a repo file: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:242` isMentionAlreadyAttached > recognizes VS Code native paths: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:247` isMentionAlreadyAttached > keeps a replayed file from another worktree: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:254` isMentionAlreadyAttached > keeps a file URL with a different host and a native UNC path distinct: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.
- `attachments/__tests__/inlineMentionAttachments.test.ts:260` isMentionAlreadyAttached > reports nothing attached when the composer has no files: `attachments/inlineMentionAttachments.ts`. Kept unchanged; red after `return attachments.some((attachment) => {` to `return !attachments.some((attachment) => {`.

## comment/__tests__/MobileCommentComposer.keyboard.test.tsx

- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:105` mobile comment composer return key > with the setting on, Enter attaches the comment: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after `true` to `false`.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:114` mobile comment composer return key > with the setting on, Shift+Enter leaves the newline to the editor: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:121` mobile comment composer return key > with the setting off, Enter inserts a newline instead of attaching: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:129` mobile comment composer return key > Ctrl+Enter attaches regardless of the setting: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after ` === ` to ` !== `.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:137` mobile comment composer return key > an IME composition Enter does not attach: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after `isIMECompositionEvent(event)` to `!(isIMECompositionEvent(event))`.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:143` mobile comment composer return key > Alt+Enter inserts a newline in Send mode: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:150` mobile comment composer return key > Cmd+Enter attaches once with the setting off: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after ` === ` to ` !== `.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:157` mobile comment composer return key > the attach button works with Return key sends false: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after `onClick={handlers.onAttach}` to `onClick={undefined}`.
- `comment/__tests__/MobileCommentComposer.keyboard.test.tsx:157` mobile comment composer return key > the attach button works with Return key sends true: `comment/MobileCommentComposer.tsx`. Kept unchanged; red after `onClick={handlers.onAttach}` to `onClick={undefined}`.

## comment/__tests__/mobileCommentDraft.test.ts

- `comment/__tests__/mobileCommentDraft.test.ts:42` mobileCommentQuotePreview > keeps the full text for width-based clipping: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `plainText.trim()` to `''`.
- `comment/__tests__/mobileCommentDraft.test.ts:47` mobileCommentQuotePreview > counts code points, not utf-16 units: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `plainText.trim()` to `''`.
- `comment/__tests__/mobileCommentDraft.test.ts:54` mobileCommentQuotePreview > trims surrounding whitespace first: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `plainText.trim()` to `''`.
- `comment/__tests__/mobileCommentDraft.test.ts:61` createMobileCommentDraftController > open requires a complete scope and a quotable selection: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `false` to `true`.
- `comment/__tests__/mobileCommentDraft.test.ts:73` createMobileCommentDraftController > edit and cancel: cancel discards the comment and later edits are rejected: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `comment/__tests__/mobileCommentDraft.test.ts:88` createMobileCommentDraftController > attach consumes the comment exactly once and keeps the full markdown: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `1` to `0`.
- `comment/__tests__/mobileCommentDraft.test.ts:115` createMobileCommentDraftController > an empty or whitespace-only comment is allowed: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `comment/__tests__/mobileCommentDraft.test.ts:123` createMobileCommentDraftController > a stale generation cannot attach or edit: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `comment/__tests__/mobileCommentDraft.test.ts:137` createMobileCommentDraftController > a transcript from a previous comment cannot leak into the next one: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `next` to `''`.
- `comment/__tests__/mobileCommentDraft.test.ts:158` createMobileCommentDraftController > a stale insert-and-attach neither writes text nor attaches the newer comment: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `comment/__tests__/mobileCommentDraft.test.ts:182` createMobileCommentDraftController > insert-and-attach appends the transcript and consumes the comment: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `comment/__tests__/mobileCommentDraft.test.ts:194` createMobileCommentDraftController > cancel with a stale generation is rejected; the current open survives: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `false` to `true`.
- `comment/__tests__/mobileCommentDraft.test.ts:214` createMobileCommentDraftController > scope switch closes the comment; a later attach cannot write: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `comment/__tests__/mobileCommentDraft.test.ts:235` createMobileCommentDraftController > ordinary chat: selection uses the target published by the visible composer: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `scope = nextScope;` to `;`.
- `comment/__tests__/mobileCommentDraft.test.ts:235` createMobileCommentDraftController > expanded BTW: selection uses the target published by the visible composer: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `scope = nextScope;` to `;`.
- `comment/__tests__/mobileCommentDraft.test.ts:235` createMobileCommentDraftController > pending BTW: selection uses the target published by the visible composer: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `scope = nextScope;` to `;`.
- `comment/__tests__/mobileCommentDraft.test.ts:235` createMobileCommentDraftController > collapsed BTW: selection uses the target published by the visible composer: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `scope = nextScope;` to `;`.
- `comment/__tests__/mobileCommentDraft.test.ts:253` createMobileCommentDraftController > collapsing BTW or unmounting invalidates late attach and dictation: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `false` to `true`.
- `comment/__tests__/mobileCommentDraft.test.ts:268` createMobileCommentDraftController > a controller in another column keeps its own draft target: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `comment/__tests__/mobileCommentDraft.test.ts:279` createMobileCommentDraftController > store-limit rejection preserves text and quote, and a retry attaches exactly once: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `null` to `[]`.
- `comment/__tests__/mobileCommentDraft.test.ts:306` createMobileCommentDraftController > a rejected insert-and-attach retains the transcript for a later retry: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `update(pending);` to `;`.
- `comment/__tests__/mobileCommentDraft.test.ts:322` createMobileCommentDraftController > open replaces an existing comment with a new generation: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `1` to `0`.
- `comment/__tests__/mobileCommentDraft.test.ts:357` openEdit > opens with the comment text; save updates that draft and adds none: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `true` to `false`.
- `comment/__tests__/mobileCommentDraft.test.ts:372` openEdit > cancel leaves the draft as it was: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `true` to `false`.
- `comment/__tests__/mobileCommentDraft.test.ts:382` openEdit > refuses a draft outside the published scope: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `comment/__tests__/mobileCommentDraft.test.ts:388` openEdit > a draft removed while editing closes the shell without re-adding it: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `null` to `[]`.
- `comment/__tests__/mobileCommentDraft.test.ts:401` isSameMobileCommentScope > compares runtime, directory and session: `comment/mobileCommentDraft.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `comment/__tests__/mobileCommentDraft.test.ts:410` applyMobileCommentAttach > writes one chat-quote draft into the captured session bucket only: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `'chat-quote'` to `''`.
- `comment/__tests__/mobileCommentDraft.test.ts:440` applyMobileCommentAttach > drops a plan whose runtime no longer matches instead of re-targeting it: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `false` to `true`.
- `comment/__tests__/mobileCommentDraft.test.ts:454` applyMobileCommentAttach > comment lifecycle leaves the normal prompt draft and attachments untouched: `comment/mobileCommentDraft.ts`. Kept unchanged; red after `const store = useInlineCommentDraftStore.getState();` to `useInputStore.getState().setPendingInputText(null);     const store = useInlineCommentDraftStore.getState();`.

## comment/__tests__/useMobileCommentComposerMode.test.tsx

- `comment/__tests__/useMobileCommentComposerMode.test.tsx:82` mobile comment composer integration > pending BTW stays open across rerenders and attaches to its published target: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.
- `comment/__tests__/useMobileCommentComposerMode.test.tsx:96` mobile comment composer integration > switching from BTW to the parent rejects the old dictation callback: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.
- `comment/__tests__/useMobileCommentComposerMode.test.tsx:109` mobile comment composer integration > failed attach keeps the editor open with an error, then retry restores the composer: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.
- `comment/__tests__/useMobileCommentComposerMode.test.tsx:126` mobile comment composer integration > a desktop composer publishes its target without opening a mobile comment: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.
- `comment/__tests__/useMobileCommentComposerMode.test.tsx:132` mobile comment composer integration > publishes the composer address for the comment surfaces: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.
- `comment/__tests__/useMobileCommentComposerMode.test.tsx:139` mobile comment composer integration > runtime switching rejects a transcript before the composer has rerendered: `comment/useMobileCommentComposerMode.ts`. Kept unchanged; red after `!runtimeKey \|\| !directory \|\| !sessionKey` to `!(!runtimeKey \|\| !directory \|\| !sessionKey)`.

## composerReferences.test.ts

- `composerReferences.test.ts:45`  > references from every source sit side by side in attach order: `composerReferences.ts`. Kept unchanged; red after `index === -1` to `!(index === -1)`.
- `composerReferences.test.ts:56`  > attaching an item again replaces it where it stands: `composerReferences.ts`. Kept unchanged; red after `index === -1` to `!(index === -1)`.
- `composerReferences.test.ts:64`  > removing one keeps the rest: `composerReferences.ts`. Kept unchanged; red after `\`repository:${reference.url.toLowerCase()}\`` to `''`.
- `composerReferences.test.ts:69`  > a reference sends its text and identity, and a guest keeps its data: `composerReferences.ts`. Kept unchanged; red after `reference.data !== undefined` to `!(reference.data !== undefined)`.
- `composerReferences.test.ts:74`  > a sent reference becomes the session link the sidebar reads: `composerReferences.ts`. Kept unchanged; red after `reference.kind === 'change-request'` to `!(reference.kind === 'change-request')`.

## editor/__tests__/ComposerEditorView.test.ts

- `editor/__tests__/ComposerEditorView.test.ts:8` ComposerEditorView > isolates the composer EditContext opt-out: `editor/ComposerEditor.tsx`. Rewritten; red after `new ComposerEditorView(` to `new EditorView(`.

## editor/__tests__/autocorrect.test.ts

- `editor/__tests__/autocorrect.test.ts:43` composerAutoCorrect > matches the pinned CodeMirror period-revert guard: `editor/autocorrect.ts`. Deleted after 2 green mutations: `if (options.isMobile) return 'on';` to `if (options.isMobile) return 'off';`; `? 'Off'` to `? 'on'`.
- `editor/__tests__/autocorrect.test.ts:61` composerAutoCorrect > preserves the macOS platform period without enabling autocorrect: `editor/autocorrect.ts`. Kept unchanged; red after `? 'Off'` to `? 'on'`.
- `editor/__tests__/autocorrect.test.ts:61` composerAutoCorrect > preserves the iPhone platform period without enabling autocorrect: `editor/autocorrect.ts`. Kept unchanged; red after `? 'Off'` to `? 'on'`.
- `editor/__tests__/autocorrect.test.ts:61` composerAutoCorrect > preserves the iPadOS touch detection platform period without enabling autocorrect: `editor/autocorrect.ts`. Kept unchanged; red after `? 'Off'` to `? 'on'`.
- `editor/__tests__/autocorrect.test.ts:61` composerAutoCorrect > preserves the Android platform period without enabling autocorrect: `editor/autocorrect.ts`. Kept unchanged; red after `? 'Off'` to `? 'on'`.
- `editor/__tests__/autocorrect.test.ts:71` composerAutoCorrect > leaves desktop correction off on Windows: `editor/autocorrect.ts`. Kept unchanged; red after `ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent)` to `!(ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent))`.
- `editor/__tests__/autocorrect.test.ts:71` composerAutoCorrect > leaves desktop correction off on Linux: `editor/autocorrect.ts`. Kept unchanged; red after `ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent)` to `!(ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent))`.
- `editor/__tests__/autocorrect.test.ts:76` composerAutoCorrect > uses CodeMirror platform detection rather than a macOS user agent: `editor/autocorrect.ts`. Kept unchanged; red after `ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent)` to `!(ios \|\| /Mac/.test(nav.platform) \|\| /Android\b/.test(nav.userAgent))`.
- `editor/__tests__/autocorrect.test.ts:86` composerAutoCorrect > preserves the existing mobile autocorrect policy: `editor/autocorrect.ts`. Kept unchanged; red after `if (options.isMobile) return 'on';` to `if (options.isMobile) return 'off';`.

## editor/__tests__/bidi.test.ts

- `editor/__tests__/bidi.test.ts:31` composer bidi lifecycle > the root remains fixed while every logical line resolves independently: `editor/bidi.ts`. Kept unchanged; red after `dir === 'rtl'` to `!(dir === 'rtl')`.
- `editor/__tests__/bidi.test.ts:39` composer bidi lifecycle > English and Latin-first Arabic lines each take the direction of most of their words: `editor/bidi.ts`. Kept unchanged; red after `dir === 'rtl'` to `!(dir === 'rtl')`.
- `editor/__tests__/bidi.test.ts:46` composer bidi lifecycle > splitting and joining lines keeps direction attributes without changing source: `editor/bidi.ts`. Kept unchanged; red after `dir === 'rtl'` to `!(dir === 'rtl')`.
- `editor/__tests__/bidi.test.ts:59` composer bidi lifecycle > direction decoration is bounded to rendered lines in a long document: `editor/bidi.ts`. Kept unchanged; red after `dir === 'rtl'` to `!(dir === 'rtl')`.

## editor/__tests__/composerHeightLimit.test.ts

- `editor/__tests__/composerHeightLimit.test.ts:6` getComposerHeightLimit > keeps short composer content below both limits: `editor/heightLimit.ts`. Kept unchanged; red after `limit` to `''`.
- `editor/__tests__/composerHeightLimit.test.ts:18` getComposerHeightLimit > [issue-2533] keeps long failed-dictation salvage text and its controls inside the mobile bound: `editor/heightLimit.ts`. Kept unchanged; red after ` - ` to ` + `.
- `editor/__tests__/composerHeightLimit.test.ts:35` getComposerHeightLimit > [issue-2533] keeps failed-dictation salvage text bounded after a short viewport reflow: `editor/heightLimit.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `editor/__tests__/composerHeightLimit.test.ts:47` getComposerHeightLimit > [issue-2533] does not feed the applied salvage height back into its limit: `editor/heightLimit.ts`. Kept unchanged; red after `0` to `1`.
- `editor/__tests__/composerHeightLimit.test.ts:71` getComposerHeightLimit > uses the line cap when a tablet has more vertical room: `editor/heightLimit.ts`. Kept unchanged; red after `limit` to `''`.
- `editor/__tests__/composerHeightLimit.test.ts:80` getComposerHeightLimit > keeps the line cap when no positive screen budget can be measured: `editor/heightLimit.ts`. Kept unchanged; red after ` > ` to ` <= `.
- `editor/__tests__/composerHeightLimit.test.ts:89` getComposerHeightLimit > falls back to the line cap when no screen bound is available: `editor/heightLimit.ts`. Kept unchanged; red after `limit` to `''`.
- `editor/__tests__/composerHeightLimit.test.ts:95` isComposerContentCapped > [issue-4004] treats a sub-line overflow of fitting text as fitting: `editor/heightLimit.ts`. Kept unchanged; red after ` - ` to ` + `.
- `editor/__tests__/composerHeightLimit.test.ts:101` isComposerContentCapped > scrolls once the text is a line or more past the cap: `editor/heightLimit.ts`. Kept unchanged; red after `2` to `1`.

## editor/__tests__/composerLanguage.test.ts

- `editor/__tests__/composerLanguage.test.ts:40` composerLanguage — initial decorations > decorates the references it knows about: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:44` composerLanguage — initial decorations > leaves unknown tokens undecorated: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:48` composerLanguage — initial decorations > decorates markdown structure: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:52` composerLanguage — initial decorations > plain prose gets no decorations at all: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:56` composerLanguage — initial decorations > an empty document is fine: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:60` composerLanguage — initial decorations > shell mode disables the language: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:65` composerLanguage — initial decorations > decorated spans carry the shared highlight classes: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:72` composerLanguage — updates > editing the document retokenizes: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:80` composerLanguage — updates > deleting a reference removes its decoration: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:86` composerLanguage — updates > a new registry repaints without touching the document: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:97` composerLanguage — updates > a transaction that changes neither keeps the same decoration set: `language/mentions.ts`. Kept unchanged; red after `0` to `1`.
- `editor/__tests__/composerLanguage.test.ts:103` composerLanguage — updates > the document stays the plain string that gets sent: `editor/ComposerEditor.tsx`. Deleted after 2 green mutations: `return viewRef.current?.state.doc.toString() ?? '';` to `return '';`; `return viewRef.current?.state.doc.toString() ?? '';` to `return viewRef.current?.state.doc.toString().replace(/[@#]/g, '') ?? '';`.
- `editor/__tests__/composerLanguage.test.ts:122` composerLanguage — bidirectional technical fragments > keeps inline code and references intact inside Arabic prose: `editor/composerLanguage.ts`. Kept unchanged; red after ` < ` to ` >= `.
- `editor/__tests__/composerLanguage.test.ts:129` composerLanguage — bidirectional technical fragments > syntax colors and nested references do not split a fenced code line: `editor/composerLanguage.ts`. Kept unchanged; red after `1` to `0`.
- `editor/__tests__/composerLanguage.test.ts:134` composerLanguage — bidirectional technical fragments > removing code delimiters removes the isolation: `editor/composerLanguage.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `editor/__tests__/composerLanguage.test.ts:141` composerLanguage — bidirectional technical fragments > shell input remains one LTR context and switching back releases it: `editor/composerLanguage.ts`. Kept unchanged; red after `0` to `1`.
- `editor/__tests__/composerLanguage.test.ts:149` composerLanguage — bidirectional technical fragments > selection-only transactions reuse the direction ranges: `editor/composerLanguage.ts`. Kept unchanged; red after `value` to `''`.
- `editor/__tests__/composerLanguage.test.ts:172` composerLanguage — attachment citations > draws a citation of an attached file as a chip: `editor/composerLanguage.ts`. Kept unchanged; red after `0` to `1`.
- `editor/__tests__/composerLanguage.test.ts:177` composerLanguage — attachment citations > shell mode keeps citations as text: `editor/composerLanguage.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `editor/__tests__/composerLanguage.test.ts:182` composerLanguage — attachment citations > keeps a token being typed as text and chips it once typing moves on: `editor/composerLanguage.ts`. Kept unchanged; red after `scanPrefixTokens(text, '$')` to `scanPrefixTokens(text, '/')`.
- `editor/__tests__/composerLanguage.test.ts:192` composerLanguage — attachment citations > chips a token that arrives whole, as from a restored draft: `editor/composerLanguage.ts`. Kept unchanged; red after `scanPrefixTokens(text, '$')` to `scanPrefixTokens(text, '/')`.
- `editor/__tests__/composerLanguage.test.ts:198` composerLanguage — attachment citations > a skill name after a slash is not a skill: `editor/composerLanguage.ts`. Kept unchanged; red after `scanPrefixTokens(text, '$')` to `scanPrefixTokens(text, '/')`.
- `editor/__tests__/composerLanguage.test.ts:205` composerLanguage — attachment citations > chips file and agent mentions and snippets; commands keep their color only: `editor/composerLanguage.ts`. Kept unchanged; red after `1` to `0`.
- `editor/__tests__/composerLanguage.test.ts:217` composerLanguage — attachment citations > a path becomes a chip when a check confirms it, and text again when dismissed: `language/mentions.ts`. Kept unchanged; red after `null` to `[]`.
- `editor/__tests__/composerLanguage.test.ts:233` composerLanguage — attachment citations > draws a citation as a chip while its file is still attaching: `editor/composerLanguage.ts`. Kept unchanged; red after `highlights: builder.finish(),` to `highlights: Decoration.set([Decoration.mark({ class: DEFAULT_HIGHLIGHT_CLASS }).range(0, text.length)]),`.
- `editor/__tests__/composerLanguage.test.ts:241` composerLanguage — attachment citations > draws a mentioned session or message link as a chip once resolved; others stay text: `editor/composerLanguage.ts`. Kept unchanged; red after `context.sessionLinkChips?.size` to `!(context.sessionLinkChips?.size)`.
- `editor/__tests__/composerLanguage.test.ts:256` composerLanguage — attachment citations > keeps a chip and the punctuation typed after it on one line, outside the chip: `editor/composerLanguage.ts`. Kept unchanged; red after `0` to `1`.

## editor/__tests__/documentEdits.test.ts

- `editor/__tests__/documentEdits.test.ts:13` replaceWithCaret > puts the caret at the end of a wholesale replacement: `editor/documentEdits.ts`. Kept unchanged; red after ` + ` to ` - `.
- `editor/__tests__/documentEdits.test.ts:24` replaceWithCaret > keeps the caret inside the document when CRLF is normalized away: `editor/documentEdits.ts`. Kept unchanged; red after ` + ` to ` - `.
- `editor/__tests__/documentEdits.test.ts:31` replaceWithCaret > survives a draft made only of CRLF breaks: `editor/documentEdits.ts`. Kept unchanged; red after ` + ` to ` - `.
- `editor/__tests__/documentEdits.test.ts:38` replaceWithCaret > places the caret after text inserted at the selection: `editor/documentEdits.ts`. Kept unchanged; red after ` + ` to ` - `.
- `editor/__tests__/documentEdits.test.ts:45` replaceWithCaret > honours an explicit caret: `editor/documentEdits.ts`. Kept unchanged; red after `Math.min(Math.max(position, 0), changes.newLength)` to `Math.max(Math.max(position, 0), changes.newLength)`.
- `editor/__tests__/documentEdits.test.ts:52` replaceWithCaret > clamps an explicit caret that the normalized document cannot hold: `editor/documentEdits.ts`. Kept unchanged; red after `Math.min(Math.max(position, 0), changes.newLength)` to `Math.max(Math.max(position, 0), changes.newLength)`.

## editor/__tests__/dom.test.ts

- `editor/__tests__/dom.test.ts:25`  > focuses the CodeMirror chat input content: `editor/dom.ts`. Kept unchanged; red after `!editor.closest('[data-chat-column="pinned"]')` to `!(!editor.closest('[data-chat-column="pinned"]'))`.
- `editor/__tests__/dom.test.ts:33`  > skips a chat pinned in the side panel, wherever it sits in the page: `editor/dom.ts`. Kept unchanged; red after `!editor.closest('[data-chat-column="pinned"]')` to `!(!editor.closest('[data-chat-column="pinned"]'))`.

## editor/__tests__/hostMouseDown.test.ts

- `editor/__tests__/hostMouseDown.test.ts:67` composer host mouse down > focuses before the first padding selection update paints the caret: `editor/hostMouseDown.ts`. Kept unchanged; red after `!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable` to `!(!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable)`.
- `editor/__tests__/hostMouseDown.test.ts:78` composer host mouse down > repaints after window reactivation even when focus bookkeeping is stale: `editor/hostMouseDown.ts`. Kept unchanged; red after `!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable` to `!(!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable)`.
- `editor/__tests__/hostMouseDown.test.ts:92` composer host mouse down > falls back to the document end when padding has no mapped position: `editor/hostMouseDown.ts`. Kept unchanged; red after `!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable` to `!(!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable)`.
- `editor/__tests__/hostMouseDown.test.ts:101` composer host mouse down > a click above or below the text keeps its x on the nearest line: `editor/hostMouseDown.ts`. Kept unchanged; red after `!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable` to `!(!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable)`.
- `editor/__tests__/hostMouseDown.test.ts:117` composer host mouse down > leaves native text selection and read-only editors alone: `editor/hostMouseDown.ts`. Kept unchanged; red after `!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable` to `!(!view \|\| view.state.readOnly \|\| !view.contentDOM.isContentEditable)`.

## editor/__tests__/imeNewline.test.ts

- `editor/__tests__/imeNewline.test.ts:91` IME newline cleanup extension > keeps the committed newline through the keymap cleanup, then allows ordinary Backspace: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:100` IME newline cleanup extension > keeps the committed newline through the DOM-read cleanup: `editor/imeNewline.ts`. Kept unchanged; red after `1` to `0`.
- `editor/__tests__/imeNewline.test.ts:108` IME newline cleanup extension > lets normal Backspace remove padding already in the document: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:114` IME newline cleanup extension > does not swallow Backspace without confirmed DOM padding: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:120` IME newline cleanup extension > does not swallow a DOM deletion without confirmed padding: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:127` IME newline cleanup extension > deletes the whole selection from 0 to 2: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:127` IME newline cleanup extension > deletes the whole selection from 2 to 0: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:136` IME newline cleanup extension > clears on caret movement, even when the caret returns to the same newline: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:145` IME newline cleanup extension > clears on document replacement at the same caret position: `editor/imeNewline.ts`. Kept unchanged; red after `insertion = null;` to `;`.
- `editor/__tests__/imeNewline.test.ts:153` IME newline cleanup extension > expires after 400 ms: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:161` IME newline cleanup extension > Enter clears the cleanup before the composer handles it: `editor/imeNewline.ts`. Kept unchanged; red after `false` to `true`.
- `editor/__tests__/imeNewline.test.ts:168` IME newline cleanup extension > unrelated input clears the cleanup: `editor/imeNewline.ts`. Kept unchanged; red after `return consume;` to `return true;`.
- `editor/__tests__/imeNewline.test.ts:203` IME newline cleanup extension > composer gates cleanup on iOS=true, Send=true: `editor/ComposerEditor.tsx`. Kept unchanged; red after `[         EditorView.contentAttributes.of({ enterkeyhint: 'send' }),         nav && isCodeMirrorIOSNavigator(nav.userAgent, nav.vendor, nav.maxTouchPoints)             ? imeNewlineCleanup() : [],     ]` to `[]`.
- `editor/__tests__/imeNewline.test.ts:203` IME newline cleanup extension > composer gates cleanup on iOS=true, Send=false: `editor/ComposerEditor.tsx`. Kept unchanged; red after `true` to `false`.
- `editor/__tests__/imeNewline.test.ts:203` IME newline cleanup extension > composer gates cleanup on iOS=false, Send=true: `editor/ComposerEditor.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `editor/__tests__/imeNewline.test.ts:212` IME newline cleanup extension > switching to Return removes an armed cleanup: `editor/ComposerEditor.tsx`. Kept unchanged; red after `viewRef.current = view;` to `;`.

## editor/__tests__/inputRedirect.test.ts

- `editor/__tests__/inputRedirect.test.ts:58`  > a printable key with nothing focused lands at the end of the main composer: `editor/inputRedirect.ts`. Kept unchanged; red after `isOnScreen(pinned)` to `!(isOnScreen(pinned))`.
- `editor/__tests__/inputRedirect.test.ts:75`  > keys that belong elsewhere stay where they are: `editor/inputRedirect.ts`. Kept unchanged; red after `layer.getClientRects().length > 0` to `!(layer.getClientRects().length > 0)`.
- `editor/__tests__/inputRedirect.test.ts:112`  > a chat pinned in the side panel receives input after the user clicks into it: `editor/inputRedirect.ts`. Kept unchanged; red after `isOnScreen(pinned)` to `!(isOnScreen(pinned))`.
- `editor/__tests__/inputRedirect.test.ts:142`  > a paste with nothing focused goes through the composer: `editor/inputRedirect.ts`. Kept unchanged; red after `isOnScreen(pinned)` to `!(isOnScreen(pinned))`.
- `editor/__tests__/inputRedirect.test.ts:171`  > a middle click in the composer moves the caret and leaves native paste in place: `editor/inputRedirect.ts`. Kept unchanged; red after `!editor` to `!(!editor)`.
- `editor/__tests__/inputRedirect.test.ts:186`  > a middle click on page chrome does not fall through to a focused composer: `editor/inputRedirect.ts`. Kept unchanged; red after `!pending` to `!(!pending)`.
- `editor/__tests__/inputRedirect.test.ts:198`  > a middle click in another text field stays native: `editor/inputRedirect.ts`. Kept unchanged; red after `isElement(target)` to `!(isElement(target))`.
- `editor/__tests__/inputRedirect.test.ts:211`  > a middle click in a shadow-root field stays native: `editor/inputRedirect.ts`. Kept unchanged; red after `isElement(target)` to `!(isElement(target))`.
- `editor/__tests__/inputRedirect.test.ts:232`  > a middle click in a terminal stays with that terminal: `editor/inputRedirect.ts`. Kept unchanged; red after `clicked !== null && clicked === pasteOwner(eventTarget(event))` to `!(clicked !== null && clicked === pasteOwner(eventTarget(event)))`.
- `editor/__tests__/inputRedirect.test.ts:249`  > a keyboard paste a non-editable surface handles stays out of the composer: `editor/inputRedirect.ts`. Kept unchanged; red after `event.defaultPrevented` to `!(event.defaultPrevented)`.
- `editor/__tests__/inputRedirect.test.ts:266`  > Windows and macOS keep the existing unowned-paste fallback: `editor/inputRedirect.ts`. Kept unchanged; red after `isOnScreen(pinned)` to `!(isOnScreen(pinned))`.
- `editor/__tests__/inputRedirect.test.ts:286`  > coming back to the window puts the caret in the composer unless focus takes text: `editor/inputRedirect.ts`. Kept unchanged; red after `targetView()?.focus();` to `;`.

## editor/__tests__/iosNativeParagraph.test.ts

- `editor/__tests__/iosNativeParagraph.test.ts:110` iOS keyboard native paragraphs (#5746) > keeps every batch the keyboard writes into its new paragraphs: `bun-patches/@codemirror%2Fview@6.43.15.patch`. Kept unchanged; red after `else if (browser.ios && !view.composing && mutations.some(` to `else if (!browser.ios && !view.composing && mutations.some(`.
- `editor/__tests__/iosNativeParagraph.test.ts:123` iOS keyboard native paragraphs (#5746) > keeps a pending paragraph when another update runs before the frame: `bun-patches/@codemirror%2Fview@6.43.15.patch`. Kept unchanged; red after `if (pendingKey \|\| this.observer.iosParagraphPending)` to `if (pendingKey)`.
- `editor/__tests__/iosNativeParagraph.test.ts:132` iOS keyboard native paragraphs (#5746) > keeps a pending paragraph when the editor is focused before the frame: `bun-patches/@codemirror%2Fview@6.43.15.patch`. Kept unchanged; red after `else if (browser.ios && !view.composing && mutations.some(` to `else if (!browser.ios && !view.composing && mutations.some(`.
- `editor/__tests__/iosNativeParagraph.test.ts:142` iOS keyboard native paragraphs (#5746) > keeps a pending paragraph when the layout is read before the frame: `bun-patches/@codemirror%2Fview@6.43.15.patch`. Kept unchanged; red after `if (flush \|\| this.observer.iosParagraphPending)` to `if (flush)`.

## editor/__tests__/largeTextPaste.integration.test.tsx

- `editor/__tests__/largeTextPaste.integration.test.tsx:89` mounted composer native paste and double-paste conversion > native first paste reports fromPaste; a second shortcut converts exactly that insertion: `largeTextPaste.ts`. Kept unchanged; red after `!snapshot \|\| !this.matches(candidate, snapshot)` to `!(!snapshot \|\| !this.matches(candidate, snapshot))`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:98` mounted composer native paste and double-paste conversion > menu paste and repeated keydown remain native: `editor/ComposerEditor.tsx`. Kept unchanged; red after `update.docChanged` to `!(update.docChanged)`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:103` mounted composer native paste and double-paste conversion > rejected attachment retains the first native insertion: `largeTextPaste.ts`. Kept unchanged; red after `!paste` to `!(!paste)`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:108` mounted composer native paste and double-paste conversion > Cmd+V uses the same conversion path: `largeTextPaste.ts`. Kept unchanged; red after `!snapshot \|\| !this.matches(candidate, snapshot)` to `!(!snapshot \|\| !this.matches(candidate, snapshot))`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:113` mounted composer native paste and double-paste conversion > Ctrl+V converts the native paste with a Cyrillic layout: `largeTextPaste.ts`. Kept unchanged; red after `!snapshot \|\| !this.matches(candidate, snapshot)` to `!(!snapshot \|\| !this.matches(candidate, snapshot))`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:113` mounted composer native paste and double-paste conversion > Cmd+V converts the native paste with a Cyrillic layout: `largeTextPaste.ts`. Kept unchanged; red after `!snapshot \|\| !this.matches(candidate, snapshot)` to `!(!snapshot \|\| !this.matches(candidate, snapshot))`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:121` mounted composer native paste and double-paste conversion > Dvorak V follows the character rather than its physical position: `largeTextPaste.ts`. Kept unchanged; red after `!snapshot \|\| !this.matches(candidate, snapshot)` to `!(!snapshot \|\| !this.matches(candidate, snapshot))`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:128` mounted composer native paste and double-paste conversion > a non-Latin key release cancels a shortcut that did not deliver a paste: `largeTextPaste.ts`. Kept unchanged; red after `resolveShortcutEventKey(event).toLowerCase() === 'v'` to `!(resolveShortcutEventKey(event).toLowerCase() === 'v')`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:141` mounted composer native paste and double-paste conversion > opening the context menu cancels a keyboard press that did not deliver a paste: `editor/ComposerEditor.tsx`. Kept unchanged; red after `update.docChanged` to `!(update.docChanged)`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:152` mounted composer native paste and double-paste conversion > editor selection invalidates the first paste: `editor/ComposerEditor.tsx`. Kept unchanged; red after `update.docChanged` to `!(update.docChanged)`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:152` mounted composer native paste and double-paste conversion > editor blur invalidates the first paste: `editor/ComposerEditor.tsx`. Kept unchanged; red after `update.docChanged` to `!(update.docChanged)`.
- `editor/__tests__/largeTextPaste.integration.test.tsx:152` mounted composer native paste and double-paste conversion > editor edit invalidates the first paste: `editor/ComposerEditor.tsx`. Kept unchanged; red after `update.docChanged` to `!(update.docChanged)`.

## editor/__tests__/pageNavigation.integration.test.tsx

- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > PageUp prevents native scrolling at the empty boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > Shift+PageUp prevents native scrolling at the empty boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > PageDown prevents native scrolling at the empty boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > Shift+PageDown prevents native scrolling at the empty boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > PageUp prevents native scrolling at the text boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > Shift+PageUp prevents native scrolling at the text boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > PageDown prevents native scrolling at the text boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.
- `editor/__tests__/pageNavigation.integration.test.tsx:55` composer page navigation at document boundaries > Shift+PageDown prevents native scrolling at the text boundary: `editor/ComposerEditor.tsx`. Kept unchanged; red after `binding.key === 'PageUp' \|\| binding.key === 'PageDown'` to `!(binding.key === 'PageUp' \|\| binding.key === 'PageDown')`.

## editor/__tests__/theme.test.ts

- `editor/__tests__/theme.test.ts:33` composerEditorTheme > text and caret take the composer foreground, not the elevated one alone: `editor/theme.ts`. Kept unchanged; red after `color: 'var(--oc-composer-foreground, var(--surface-elevated-foreground))',` to `color: 'var(--oc-composerForeground, var(--surface-elevated-foreground))',`.
- `editor/__tests__/theme.test.ts:45` composerEditorTheme > its selectors compile and the theme can be installed: `editor/theme.ts`. Kept unchanged; red after `export const composerEditorTheme = EditorView.theme(COMPOSER_EDITOR_THEME_SPEC);` to `export const composerEditorTheme = COMPOSER_EDITOR_THEME_SPEC;`.
- `editor/__tests__/theme.test.ts:55` composerEditorTheme > the caret is coloured where it is drawn, not on the native caret: `editor/theme.ts`. Kept unchanged; red after `borderLeftColor:` to `caretColor:`.
- `editor/__tests__/theme.test.ts:60` composerEditorTheme > the drawn caret follows the theme rather than a fixed colour: `editor/theme.ts`. Kept unchanged; red after `borderLeftColor:` to `caretColor:`.
- `editor/__tests__/theme.test.ts:66` composerEditorTheme > the drawn caret is wide enough to remain prominent: `editor/theme.ts`. Kept unchanged; red after `'2px'` to `''`.
- `editor/__tests__/theme.test.ts:79` composerEditorTheme > the caret rule is specific enough to beat the base theme: `editor/theme.ts`. Kept unchanged; red after `'&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor'` to `'.cm-cursor, .cm-dropCursor'`.
- `editor/__tests__/theme.test.ts:90` composerEditorTheme > the focused selection is styled at the depth CodeMirror uses: `editor/theme.ts`. Kept unchanged; red after `'&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground'` to `'&.cm-focused .cm-selectionBackground'`.
- `editor/__tests__/theme.test.ts:105` composerEditorTheme > every theme token is kebab-case, as the theme emits them: `editor/theme.ts`. Kept unchanged; red after `color: 'var(--oc-composer-foreground, var(--surface-elevated-foreground))',` to `color: 'var(--oc-composerForeground, var(--surface-elevated-foreground))',`.
- `editor/__tests__/theme.test.ts:111` composerEditorTheme > the selection is translucent so token colours survive it: `editor/theme.ts`. Kept unchanged; red after `'color-mix(in srgb, var(--interactive-selection) 45%, transparent)'` to `''`.
- `editor/__tests__/theme.test.ts:122` composerEditorTheme > the common theme does not re-show the native selection: `editor/theme.ts`. Kept unchanged; red after `'.cm-line': { padding: '0' },` to `'.cm-line::selection': { backgroundColor: 'var(--interactive-selection)' },`.
- `editor/__tests__/theme.test.ts:140` composerNativeSelectionTheme > it compiles and can be installed: `editor/theme.ts`. Kept unchanged; red after `    composerNativeSelectionTheme,` to `    NATIVE_SELECTION_THEME_SPEC,`.
- `editor/__tests__/theme.test.ts:151` composerNativeSelectionTheme > the native selection is re-shown with enough weight to win: `editor/theme.ts`. Kept unchanged; red after `'var(--interactive-selection) !important',` to `'var(--interactiveSelection) !important',`.
- `editor/__tests__/theme.test.ts:162` composerNativeSelectionTheme > the painted selection layer is hidden so highlights do not stack: `editor/theme.ts`. Kept unchanged; red after `'none'` to `''`.
- `editor/__tests__/theme.test.ts:181` composerNativeSelectionTheme > the native caret is re-enabled, since the handles take its colour: `editor/theme.ts`. Kept unchanged; red after `'var(--oc-composer-foreground, var(--surface-elevated-foreground)) !important'` to `''`.
- `editor/__tests__/theme.test.ts:192` composerNativeSelectionTheme > the native caret shows only while a range is selected: `editor/theme.ts`. Kept unchanged; red after `'&.cm-editor.oc-native-range .cm-content, &.cm-editor.oc-native-range .cm-content .cm-line'` to `'&.cm-editor .cm-content, &.cm-editor .cm-content .cm-line'`.
- `editor/__tests__/theme.test.ts:201` composerNativeSelectionTheme > the drawn cursor layer is hidden so there are not two carets: `editor/theme.ts`. Kept unchanged; red after `'none'` to `''`.
- `editor/__tests__/theme.test.ts:209` composerNativeSelectionTheme > every theme token is kebab-case, as the theme emits them: `editor/theme.ts`. Kept unchanged; red after `'var(--interactive-selection) !important',` to `'var(--interactiveSelection) !important',`.
- `editor/__tests__/theme.test.ts:221` composerIOSSelectionExtension > it compiles and can be installed: `editor/theme.ts`. Kept unchanged; red after `EditorView.theme(IOS_SELECTION_THEME_SPEC);` to `IOS_SELECTION_THEME_SPEC;`.
- `editor/__tests__/theme.test.ts:231` composerIOSSelectionExtension > CodeMirror selection and handles are raised above token backgrounds: `editor/theme.ts`. Kept unchanged; red after `'100 !important'` to `''`.
- `editor/__tests__/theme.test.ts:239` composerIOSSelectionExtension > the layer does not intercept touch: `editor/theme.ts`. Kept unchanged; red after `'none'` to `''`.
- `editor/__tests__/theme.test.ts:248` composerIOSSelectionExtension > the scroller reserves unclipped room for both handles: `editor/theme.ts`. Kept unchanged; red after `'8px'` to `''`.
- `editor/__tests__/theme.test.ts:253` composerIOSSelectionExtension > the CodeMirror fill does not stack over the iOS system highlight: `editor/theme.ts`. Kept unchanged; red after `'transparent !important'` to `''`.
- `editor/__tests__/theme.test.ts:262` composerIOSSelectionExtension > it does not add a second selection implementation: `editor/theme.ts`. Deleted after 2 green mutations: `EditorView.theme(IOS_SELECTION_THEME_SPEC);` to `[EditorView.theme(IOS_SELECTION_THEME_SPEC), composerNativeSelectionExtension];`; `EditorView.theme(IOS_SELECTION_THEME_SPEC);` to `EditorView.theme({ ...IOS_SELECTION_THEME_SPEC, ...NATIVE_SELECTION_THEME_SPEC });`.
- `editor/__tests__/theme.test.ts:279` composerSelectionExtension > the CodeMirror iOS path uses its handles; other platforms keep native selection: `editor/theme.ts`. Kept unchanged; red after `useCodeMirrorIOSHandles` to `!(useCodeMirrorIOSHandles)`.
- `editor/__tests__/theme.test.ts:290` composerSelectionExtension > the platform predicate matches CodeMirror 6.43.9: `editor/theme.ts`. Kept unchanged; red after ` > ` to ` <= `.

## editor/__tests__/valuePropChange.integration.test.tsx

- `editor/__tests__/valuePropChange.integration.test.tsx:55` composer change reports text set through the value prop > a prompt handed in through value is marked as set by the app: `editor/ComposerEditor.tsx`. Kept unchanged; red after `!host` to `!(!host)`.
- `editor/__tests__/valuePropChange.integration.test.tsx:61` composer change reports text set through the value prop > text inserted at the caret is not marked: `editor/ComposerEditor.tsx`. Kept unchanged; red after `!host` to `!(!host)`.
- `editor/__tests__/valuePropChange.integration.test.tsx:70` composer change reports text set through the value prop > a new revision writes a value equal to the last rendered one: `editor/ComposerEditor.tsx`. Kept unchanged; red after `!host` to `!(!host)`.

## editor/__tests__/writebackCompositionGuard.test.ts

- `editor/__tests__/writebackCompositionGuard.test.ts:18` composer value writeback composition guard (issue #2527) > checks equality, then composition, before dispatching: `editor/ComposerEditor.tsx`. Rewritten; red after `if (view.compositionStarted) return;` to `if (!view.compositionStarted) return;`.

## keyboardPolicy.test.ts

- `keyboardPolicy.test.ts:56` Enter key policy > mobile requires Ctrl/Cmd to submit regardless of synced settings or Shift: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {}: `keyboardPolicy.ts`. Kept unchanged; red after `return !input.shiftKey && (!input.altKey \|\| isCtrlEnter);` to `return !input.altKey \|\| isCtrlEnter;`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"ctrlKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `return !input.shiftKey && (!input.altKey \|\| isCtrlEnter);` to `return !input.altKey \|\| isCtrlEnter;`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `return !input.shiftKey && (!input.altKey \|\| isCtrlEnter);` to `return !input.altKey \|\| isCtrlEnter;`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"ctrlKey":true,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `return !input.shiftKey && (!input.altKey \|\| isCtrlEnter);` to `return !input.altKey \|\| isCtrlEnter;`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isMobile":true}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isMobile":true,"ctrlKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isMobile":true,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isMobile":true,"ctrlKey":true,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isDesktopExpanded":true}: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isDesktopExpanded":true,"ctrlKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `input.isDesktopExpanded` to `!(input.isDesktopExpanded)`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isDesktopExpanded":true,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `input.isDesktopExpanded` to `!(input.isDesktopExpanded)`.
- `keyboardPolicy.test.ts:79` Enter key policy > untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: {"isDesktopExpanded":true,"ctrlKey":true,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `input.isDesktopExpanded` to `!(input.isDesktopExpanded)`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile default Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > desktop default Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > desktop default Alt+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `return !input.shiftKey && (!input.altKey \|\| isCtrlEnter);` to `return !input.shiftKey;`.
- `keyboardPolicy.test.ts:87` Enter key policy > desktop default Ctrl+Alt+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > desktop focus mode default Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `input.isDesktopExpanded` to `!(input.isDesktopExpanded)`.
- `keyboardPolicy.test.ts:87` Enter key policy > configured enabled Enter sends on desktop: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured enabled Alt+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured enabled Shift+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured disabled Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured disabled Shift+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured disabled Ctrl+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured disabled Ctrl+Alt+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured disabled Cmd+Shift+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `keyboardPolicy.test.ts:87` Enter key policy > configured Ctrl+Enter sends on desktop: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > configured Meta+Enter sends on desktop: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > expanded composer Enter inserts a newline when Enter-to-send is enabled: `keyboardPolicy.ts`. Kept unchanged; red after `input.isDesktopExpanded` to `!(input.isDesktopExpanded)`.
- `keyboardPolicy.test.ts:87` Enter key policy > expanded composer Alt+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > expanded composer Shift+Enter inserts a newline when Enter-to-send is disabled: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > expanded composer Ctrl+Enter sends despite Enter-to-send being disabled: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > expanded composer Cmd+Enter sends despite Enter-to-send being enabled: `keyboardPolicy.ts`. Kept unchanged; red after `isCtrlEnter` to `''`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile expanded Ctrl+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile expanded Meta+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile return-key send Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile return-key send Alt+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile Ctrl+Alt+Enter sends: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile return-key send Shift+Enter inserts a newline: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile return-key send off keeps Enter a newline: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:87` Enter key policy > mobile return-key send keeps Ctrl+Enter sending: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:102` deferred Enter modifiers > Android deferred Enter ignores the synced desktop preference and keeps Ctrl/Cmd: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:119` deferred Enter modifiers > mobile deferred Ctrl/Cmd submits even with Shift: {"shiftKey":true,"ctrlKey":true,"metaKey":false}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:119` deferred Enter modifiers > mobile deferred Ctrl/Cmd submits even with Shift: {"shiftKey":true,"ctrlKey":false,"metaKey":true}: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:127` deferred Enter modifiers > preserves Shift: `keyboardPolicy.ts`. Kept unchanged; red after `true` to `false`.
- `keyboardPolicy.test.ts:127` deferred Enter modifiers > preserves Ctrl: `keyboardPolicy.ts`. Kept unchanged; red after `true` to `false`.
- `keyboardPolicy.test.ts:127` deferred Enter modifiers > preserves Meta: `keyboardPolicy.ts`. Kept unchanged; red after `true` to `false`.
- `keyboardPolicy.test.ts:127` deferred Enter modifiers > preserves Alt: `keyboardPolicy.ts`. Kept unchanged; red after `true` to `false`.
- `keyboardPolicy.test.ts:127` deferred Enter modifiers > preserves Shift+Ctrl+Meta+Alt: `keyboardPolicy.ts`. Kept unchanged; red after `true` to `false`.
- `keyboardPolicy.test.ts:136` deferred Enter modifiers > does not restore iOS auto-capitalization as Shift: `keyboardPolicy.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `keyboardPolicy.test.ts:144` deferred Enter modifiers > return-key send submits the soft keyboard even when the real Enter reported Shift: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:154` deferred Enter modifiers > return-key send keeps a hardware Shift+Enter newline: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:163` deferred Enter modifiers > return-key send cannot strip a Shift already on the synthetic Enter: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:173` deferred Enter modifiers > return-key send keeps deferred Ctrl+Enter submitting: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:193` Shift+Enter in a numbered list on mobile > deferred Enter modifiers > a hardware keyboard continues the list without sending, returnKeySends=false: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:193` Shift+Enter in a numbered list on mobile > deferred Enter modifiers > a hardware keyboard continues the list without sending, returnKeySends=true: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:202` Shift+Enter in a numbered list on mobile > deferred Enter modifiers > a soft keyboard phantom Shift stays out of both Return modes: `keyboardPolicy.ts`. Kept unchanged; red after `if (input.isMobile) return isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey);` to `if (input.isMobile) return !(isCtrlEnter \|\| (input.returnKeySends === true && !input.shiftKey && !input.altKey));`.
- `keyboardPolicy.test.ts:210` Shift+Enter in a numbered list on mobile > deferred Enter modifiers > desktop always keeps the deferred Shift: `keyboardPolicy.ts`. Kept unchanged; red after ` \|\| ` to ` && `.

## language/__tests__/mentions.test.ts

- `language/__tests__/mentions.test.ts:20` scanMentions — boundaries > a mention at the start of the text: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:24` scanMentions — boundaries > a mention after whitespace: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:28` scanMentions — boundaries > an email address is not a mention: `language/mentions.ts`. Kept unchanged; red after ` <= ` to ` > `.
- `language/__tests__/mentions.test.ts:32` scanMentions — boundaries > a scoped package is not a mention: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:37` scanMentions — boundaries > opening punctuation still starts a mention: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:41` scanMentions — boundaries > multiple mentions on one line: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:45` scanMentions — boundaries > mentions across lines: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:49` scanMentions — boundaries > a bare @ is not a mention: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:53` scanMentions — boundaries > a token that cleans away to nothing is skipped: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:57` scanMentions — boundaries > text without @ scans to nothing: `language/mentions.ts`. Kept unchanged; red after `[]` to `null`.
- `language/__tests__/mentions.test.ts:62` scanMentions — boundaries > isMentionBoundary agrees with the scanner: `language/mentions.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/mentions.test.ts:71` scanMentions — name cleanup > trailing sentence punctuation is not part of the name: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:76` scanMentions — name cleanup > wrapping quotes and brackets are stripped from both ends: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:82` scanMentions — name cleanup > the raw token still covers the punctuation the name dropped: `language/mentions.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/mentions.test.ts:86` scanMentions — name cleanup > the reference span excludes brushing punctuation: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:92` scanMentions — name cleanup > leading noise shifts the reference span past it: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:98` scanMentions — name cleanup > a trailing slash is kept — directories are mentionable: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:102` scanMentions — name cleanup > cleanMentionName is idempotent: `language/mentions.ts`. Kept unchanged; red after `.replace(TRAILING_NOISE, '')` to ``.
- `language/__tests__/mentions.test.ts:108` scanMentions — offsets > a clean token has identical reference and raw spans: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:123` classifyMention > a known agent name classifies as an agent: `language/mentions.ts`. Kept unchanged; red after `'agent'` to `''`.
- `language/__tests__/mentions.test.ts:127` classifyMention > agent matching is case-insensitive: `language/mentions.ts`. Kept unchanged; red after `'agent'` to `''`.
- `language/__tests__/mentions.test.ts:131` classifyMention > a path-like name is only a candidate until it is confirmed: `language/mentions.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `language/__tests__/mentions.test.ts:138` classifyMention > a picker-confirmed extensionless name classifies as a file: `language/mentions.ts`. Kept unchanged; red after `classifier.confirmedMentions.has(name)` to `!(classifier.confirmedMentions.has(name))`.
- `language/__tests__/mentions.test.ts:142` classifyMention > an unknown bare word classifies as nothing: `language/mentions.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/mentions.test.ts:147` classifyMention > HTML fragments do not classify as file references: `language/mentions.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/mentions.test.ts:152` classifyMention > an agent name wins over a file-looking name: `language/mentions.ts`. Kept unchanged; red after `false` to `true`.
- `language/__tests__/mentions.test.ts:161` classifyMention > calls, URLs and versions are not shaped like a path until confirmed: `language/mentions.ts`. Kept unchanged; red after `false` to `true`.
- `language/__tests__/mentions.test.ts:171` classifyMention > brackets and an @ folder stay shaped like a path: `language/mentions.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `language/__tests__/mentions.test.ts:177` classifyMention > a dismissed name is no reference until it is confirmed again: `language/mentions.ts`. Kept unchanged; red after ` + ` to ` - `.
- `language/__tests__/mentions.test.ts:194` classifyMention > looksLikeFilePath is independent of the agent list: `language/mentions.ts`. Kept unchanged; red after `true` to `false`.
- `language/__tests__/mentions.test.ts:208` isMentionEntryInText > a confirmed path must appear exactly: `language/mentions.ts`. Kept unchanged; red after `!entry.startsWith(DISMISSED_PREFIX)` to `!(!entry.startsWith(DISMISSED_PREFIX))`.
- `language/__tests__/mentions.test.ts:213` isMentionEntryInText > a dismissal lasts while its mention does, in any case: `language/mentions.ts`. Kept unchanged; red after `!entry.startsWith(DISMISSED_PREFIX)` to `!(!entry.startsWith(DISMISSED_PREFIX))`.
- `language/__tests__/mentions.test.ts:220` scanMentions — dismissed paths with spaces > a dismissed spaced path stays whole, so no part of it reads as a file: `language/mentions.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/mentions.test.ts:231` scanMentions — confirmed paths with spaces > a confirmed path keeps its spaces: `language/mentions.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/mentions.test.ts:237` scanMentions — confirmed paths with spaces > the longest confirmed path wins: `language/mentions.ts`. Kept unchanged; red after ` - ` to ` + `.
- `language/__tests__/mentions.test.ts:242` scanMentions — confirmed paths with spaces > a confirmed path must end at a boundary: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:246` scanMentions — confirmed paths with spaces > trailing punctuation ends a confirmed path: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.
- `language/__tests__/mentions.test.ts:251` scanMentions — confirmed paths with spaces > without the confirmed set the scan stops at whitespace: `language/mentions.ts`. Kept unchanged; red after `/@([^\s]+)/g` to `/(@[^\s]*)/g`.

## language/__tests__/paths.test.ts

- `language/__tests__/paths.test.ts:8` scanPaths — what counts as a path > a home-relative path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:12` scanPaths — what counts as a path > a project-relative path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:16` scanPaths — what counts as a path > a bare filename with an extension: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:20` scanPaths — what counts as a path > a windows path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:24` scanPaths — what counts as a path > a word without a separator or extension is prose: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:29` scanPaths — what counts as a path > an approximate number is prose: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:33` scanPaths — what counts as a path > an approximate decimal is prose, not a file: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:41` scanPaths — boundaries > a path at the start of the text: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:45` scanPaths — boundaries > a tilde inside a word is not a path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:49` scanPaths — boundaries > brackets and quotes still open a path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:53` scanPaths — boundaries > several paths on one line: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:57` scanPaths — boundaries > trailing sentence punctuation is not part of the path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:63` scanPaths — not confused with other tilde syntax > a tilde code fence is left alone: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:67` scanPaths — not confused with other tilde syntax > strikethrough is left alone: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:71` scanPaths — not confused with other tilde syntax > text without a tilde scans to nothing: `language/paths.ts`. Kept unchanged; red after `if (!text \|\| !text.includes('~')) return [];` to `if (!text \|\| !text.includes('~')) return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:78` pathHighlightRanges > the range covers the tilde and the path: `language/paths.ts`. Kept unchanged; red after `return tokens;` to `return [{ start: 0, end: text.length, path: text }];`.
- `language/__tests__/paths.test.ts:85` pathHighlightRanges > prose produces no ranges: `language/paths.ts`. Kept unchanged; red after `if (!text \|\| !text.includes('~')) return [];` to `if (!text \|\| !text.includes('~')) return [{ start: 0, end: text.length, path: text }];`.

## language/__tests__/prefixTokens.test.ts

- `language/__tests__/prefixTokens.test.ts:15` scanPrefixTokens — boundaries > a token at the start of the text: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:20` scanPrefixTokens — boundaries > a token after whitespace, mid-sentence: `language/prefixTokens.ts`. Kept unchanged; red after `!text \|\| !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil))` to `!(!text \|\| !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil)))`.
- `language/__tests__/prefixTokens.test.ts:25` scanPrefixTokens — boundaries > a token after a newline: `language/prefixTokens.ts`. Kept unchanged; red after `!text \|\| !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil))` to `!(!text \|\| !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil)))`.
- `language/__tests__/prefixTokens.test.ts:29` scanPrefixTokens — boundaries > a path segment is not a slash token: `language/prefixTokens.ts`. Kept unchanged; red after `(^\|\\s)` to `()`.
- `language/__tests__/prefixTokens.test.ts:34` scanPrefixTokens — boundaries > a fragment or issue reference is not a snippet token: `language/prefixTokens.ts`. Kept unchanged; red after `(^\|\\s)` to `()`.
- `language/__tests__/prefixTokens.test.ts:39` scanPrefixTokens — boundaries > multiple tokens on one line: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:43` scanPrefixTokens — boundaries > a name must start with an alphanumeric: `language/prefixTokens.ts`. Kept unchanged; red after `'[A-Za-z0-9][A-Za-z0-9_-]*'` to `'[A-Za-z0-9_-]*'`.
- `language/__tests__/prefixTokens.test.ts:49` scanPrefixTokens — boundaries > names may contain dashes, underscores and digits: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:57` scanPrefixTokens — boundaries > a bare sigil is not a token: `language/prefixTokens.ts`. Kept unchanged; red after `'[A-Za-z0-9][A-Za-z0-9_-]*'` to `'[A-Za-z0-9_-]*'`.
- `language/__tests__/prefixTokens.test.ts:62` scanPrefixTokens — boundaries > text without the sigil scans to nothing: `language/prefixTokens.ts`. Kept unchanged; red after `[]` to `null`.
- `language/__tests__/prefixTokens.test.ts:67` scanPrefixTokens — boundaries > the two sigils do not see each other: `language/prefixTokens.ts`. Kept unchanged; red after `'/': ['/'],` to `'/': ['/', '#'],`.
- `language/__tests__/prefixTokens.test.ts:74` scanPrefixTokens — IME spellings of the skill sigil > a yen sign opens a skill token: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:79` scanPrefixTokens — IME spellings of the skill sigil > a fullwidth yen sign opens a skill token: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:83` scanPrefixTokens — IME spellings of the skill sigil > a fullwidth dollar sign opens a skill token: `language/prefixTokens.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/prefixTokens.test.ts:87` scanPrefixTokens — IME spellings of the skill sigil > the token span covers the sigil the user typed: `language/prefixTokens.ts`. Kept unchanged; red after ` + ` to ` - `.
- `language/__tests__/prefixTokens.test.ts:94` scanPrefixTokens — IME spellings of the skill sigil > the skill sigil still needs a word boundary: `language/prefixTokens.ts`. Kept unchanged; red after `(^\|\\s)` to `()`.
- `language/__tests__/prefixTokens.test.ts:99` scanPrefixTokens — IME spellings of the skill sigil > currency stays prose because membership decides: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:106` lastPrefixSigilIndex > finds the nearest sigil across spellings: `language/prefixTokens.ts`. Kept unchanged; red after `Math.max(last, text.lastIndexOf(sigil))` to `Math.min(last, text.lastIndexOf(sigil))`.
- `language/__tests__/prefixTokens.test.ts:111` lastPrefixSigilIndex > returns -1 when the text has no sigil: `language/prefixTokens.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/prefixTokens.test.ts:117` scanPrefixTokens — offsets > start and end delimit the sigil plus the name: `language/prefixTokens.ts`. Kept unchanged; red after ` + ` to ` - `.
- `language/__tests__/prefixTokens.test.ts:124` scanPrefixTokens — offsets > the boundary whitespace is not part of the token: `language/prefixTokens.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/prefixTokens.test.ts:129` scanPrefixTokens — offsets > adjacent tokens keep independent offsets: `language/prefixTokens.ts`. Kept unchanged; red after `2` to `1`.
- `language/__tests__/prefixTokens.test.ts:139` filterKnownTokens > keeps only tokens present in the known set: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:144` filterKnownTokens > case-insensitive is the default comparison: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:149` filterKnownTokens > exact comparison respects the registered casing: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:155` filterKnownTokens > an empty known set matches nothing: `language/prefixTokens.ts`. Kept unchanged; red after `[]` to `null`.
- `language/__tests__/prefixTokens.test.ts:161` collectKnownTokenNames > returns distinct names in first-occurrence order: `language/prefixTokens.ts`. Kept unchanged; red after `seen.add(token.name);` to `;`.
- `language/__tests__/prefixTokens.test.ts:169` collectKnownTokenNames > unknown tokens are dropped: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:174` collectKnownTokenNames > exact comparison is available for registry-cased names: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/prefixTokens.test.ts:181` collectKnownTokenNames > no tokens yields an empty list: `language/prefixTokens.ts`. Kept unchanged; red after `names` to `''`.

## language/__tests__/tokenize.test.ts

- `language/__tests__/tokenize.test.ts:30` tokenizeComposer — reference constructs > a known agent mention is styled as an agent: `language/tokenize.ts`. Kept unchanged; red after `ranges.push({ start: token.start, end: token.end, kind });` to `;`.
- `language/__tests__/tokenize.test.ts:34` tokenizeComposer — reference constructs > a path mention is styled as a file: `language/tokenize.ts`. Kept unchanged; red after `ranges.push({ start: token.start, end: token.end, kind });` to `;`.
- `language/__tests__/tokenize.test.ts:38` tokenizeComposer — reference constructs > a path nothing confirmed yet stays plain: `language/tokenize.ts`. Kept unchanged; red after `kind` to `!(kind)`.
- `language/__tests__/tokenize.test.ts:42` tokenizeComposer — reference constructs > an unknown bare mention is not tokenized: `language/tokenize.ts`. Kept unchanged; red after `kind` to `!(kind)`.
- `language/__tests__/tokenize.test.ts:46` tokenizeComposer — reference constructs > a known slash token is styled as a command: `language/tokenize.ts`. Kept unchanged; red after `'mentionCommand'` to `''`.
- `language/__tests__/tokenize.test.ts:50` tokenizeComposer — reference constructs > an unknown slash token stays plain prose: `language/prefixTokens.ts`. Kept unchanged; red after `return tokens.filter((token) => known.has(         compare === 'exact' ? token.name : token.name.toLowerCase(),     ));` to `return [...tokens];`.
- `language/__tests__/tokenize.test.ts:54` tokenizeComposer — reference constructs > a known snippet trigger is styled as a snippet: `language/tokenize.ts`. Kept unchanged; red after `'mentionSnippet'` to `''`.
- `language/__tests__/tokenize.test.ts:58` tokenizeComposer — reference constructs > a known skill is styled as a command: `language/tokenize.ts`. Kept unchanged; red after `'mentionCommand'` to `''`.
- `language/__tests__/tokenize.test.ts:63` tokenizeComposer — reference constructs > a skill typed with a CJK IME sigil is styled the same: `language/tokenize.ts`. Kept unchanged; red after `'mentionCommand'` to `''`.
- `language/__tests__/tokenize.test.ts:68` tokenizeComposer — reference constructs > an attachment citation is styled as a file: `packages/ui/src/components/chat/attachmentCitations.ts`. Kept unchanged; red after `if (known.has(normalizeFilenameKey(name))) {` to `if (!known.has(normalizeFilenameKey(name))) {`.
- `language/__tests__/tokenize.test.ts:73` tokenizeComposer — reference constructs > a citation for a file that is not attached is not tokenized: `packages/ui/src/components/chat/attachmentCitations.ts`. Kept unchanged; red after `if (known.has(normalizeFilenameKey(name))) {` to `if (!known.has(normalizeFilenameKey(name))) {`.
- `language/__tests__/tokenize.test.ts:80` tokenizeComposer — a path is highlighted but never attached > a ~path is styled: `language/tokenize.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/tokenize.test.ts:84` tokenizeComposer — a path is highlighted but never attached > it needs no registry and no confirmation, unlike @: `language/tokenize.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/tokenize.test.ts:91` tokenizeComposer — a path is highlighted but never attached > an @mention covering the same text keeps its own style: `language/tokenize.ts`. Kept unchanged; red after `ranges.push({ start: token.start, end: token.end, kind });` to `;`.
- `language/__tests__/tokenize.test.ts:95` tokenizeComposer — a path is highlighted but never attached > both forms can appear in one message: `language/tokenize.ts`. Kept unchanged; red after `ranges.push({ start: token.start, end: token.end, kind });` to `;`.
- `language/__tests__/tokenize.test.ts:102` tokenizeComposer — emphasis and attention > emphasis is tokenized: `language/tokenize.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/tokenize.test.ts:107` tokenizeComposer — emphasis and attention > an attention line is tokenized: `language/tokenize.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/tokenize.test.ts:111` tokenizeComposer — emphasis and attention > shell mode still disables everything: `language/tokenize.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `language/__tests__/tokenize.test.ts:118` tokenizeComposer — markdown still applies > markdown and references coexist in one pass: `language/tokenize.ts`. Kept unchanged; red after `'mentionCommand'` to `''`.
- `language/__tests__/tokenize.test.ts:123` tokenizeComposer — markdown still applies > fenced code is tokenized: `language/tokenize.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/tokenize.test.ts:129` tokenizeComposer — disabled and empty paths > shell mode tokenizes nothing: `language/tokenize.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `language/__tests__/tokenize.test.ts:134` tokenizeComposer — disabled and empty paths > empty text tokenizes nothing: `language/tokenize.ts`. Kept unchanged; red after `[]` to `null`.
- `language/__tests__/tokenize.test.ts:138` tokenizeComposer — disabled and empty paths > empty registries leave their sigils plain: `language/prefixTokens.ts`. Kept unchanged; red after `if (known.size === 0) return [];` to `if (known.size === 0) return [...tokens];`.
- `language/__tests__/tokenize.test.ts:147` tokenizeComposer — ranges are usable > every range indexes real text: `packages/ui/src/components/chat/attachmentCitations.ts`. Kept unchanged; red after `ranges.push({ start, end: end + 1 });` to `ranges.push({ start, end: end + 2 });`.
- `language/__tests__/tokenize.test.ts:157` tokenizeComposer — ranges are usable > the ranges reconstruct the text exactly through buildHighlightParts: `language/tokenize.ts`. Kept unchanged; red after `ranges` to `''`.
- `language/__tests__/tokenize.test.ts:164` tokenizeComposer — ranges are usable > a mention inside inline code keeps the mention style: `language/tokenize.ts`. Kept unchanged; red after `ranges.push({ start: token.start, end: token.end, kind });` to `;`.
- `language/__tests__/tokenize.test.ts:174` tokenizeMentions > classifies agents and files, skipping unknown words: `language/tokenize.ts`. Kept unchanged; red after `ranges` to `''`.
- `language/__tests__/tokenize.test.ts:184` tokenizeMentions > a picker-confirmed extensionless name counts as a file: `language/tokenize.ts`. Kept unchanged; red after `ranges` to `''`.

## language/__tests__/triggers.test.ts

- `language/__tests__/triggers.test.ts:15` command palette > a leading slash opens the command palette: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:19` command palette > a bare leading slash opens it with an empty query: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:23` command palette > a space anywhere turns it into an invocation, not a search: `language/triggers.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `language/__tests__/triggers.test.ts:28` command palette > the caret must stay inside the command word: `language/triggers.ts`. Deleted after 2 green mutations: `if (cursorPosition > commandEnd) return null;` to `if (false) return null;`; `const commandEnd = firstNewline === -1 ? value.length : firstNewline;` to `const commandEnd = value.length;`.
- `language/__tests__/triggers.test.ts:32` command palette > a slash that is not in the first column opens nothing: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:40` skill picker > a dollar at the start of the text opens the skill picker: `language/triggers.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/triggers.test.ts:45` skill picker > a dollar after whitespace opens it: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:49` skill picker > a dollar after a newline opens it: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:53` skill picker > the sigils a CJK IME produces open it too: `language/triggers.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/triggers.test.ts:59` skill picker > an IME sigil after whitespace opens it: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:63` skill picker > the nearest sigil wins across spellings: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:67` skill picker > a dollar inside a word does not open it: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:71` skill picker > a space after the sigil closes it: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:75` skill picker > the nearest dollar before the caret wins: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:79` skill picker > works after a command invocation: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:85` snippet picker > a hash after whitespace opens the snippet picker: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:89` snippet picker > a hash at the start of the text opens it: `language/triggers.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/triggers.test.ts:93` snippet picker > an issue reference does not open it: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:97` snippet picker > a dollar outranks a hash when both are candidates: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:103` mention picker > an at-sign after whitespace opens the mention picker: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:107` mention picker > a bare at-sign opens it with an empty query: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:111` mention picker > an email address does not open it: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:115` mention picker > a space after the sigil closes it: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:119` mention picker > a space keeps it open while the query still names a session: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:131` mention picker > a pasted at-sign does not open the picker: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:139` mention picker > a paste without an at-sign still resolves normally: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:149` precedence and disabling > shell mode disables every picker: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:157` precedence and disabling > a leading slash opens commands only, never the skill picker: `language/triggers.ts`. Kept unchanged; red after `1` to `0`.
- `language/__tests__/triggers.test.ts:161` precedence and disabling > plain prose triggers nothing: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `language/__tests__/triggers.test.ts:168`  > BTW leaves file and agent references as text while retaining other pickers: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:179` matchSnippetTrigger > reads the query after a # at a word boundary: `language/triggers.ts`. Kept unchanged; red after `0` to `1`.
- `language/__tests__/triggers.test.ts:184` matchSnippetTrigger > ignores a # inside a word or a finished token: `language/triggers.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `language/__tests__/triggers.test.ts:191` emoji trigger > opens on a typed colon and two letters at a word boundary: `language/triggers.ts`. Kept unchanged; red after `'emoji'` to `''`.
- `language/__tests__/triggers.test.ts:197` emoji trigger > stays shut for times, links, key: value, smileys and finished shortcodes: `language/triggers.ts`. Kept unchanged; red after `null` to `[]`.
- `language/__tests__/triggers.test.ts:207` emoji trigger > a mention outranks it: `language/triggers.ts`. Kept unchanged; red after ` === ` to ` !== `.

## linkedReferenceDrafts.test.ts

- `linkedReferenceDrafts.test.ts:28` composer reference chips > a chip attached in one session stays out of every other session: `linkedReferenceDrafts.ts`. Kept unchanged; red after `0` to `1`.
- `linkedReferenceDrafts.test.ts:42` composer reference chips > clearing the draft that sent leaves another draft untouched: `linkedReferenceDrafts.ts`. Kept unchanged; red after `drafts.delete(key);` to `;`.
- `linkedReferenceDrafts.test.ts:54` composer reference chips > the same session in another directory is another composer: `packages/ui/src/lib/chatDraftPersistence.ts`. Kept unchanged; red after `JSON.stringify([identity.runtimeKey, identity.directory, identity.sessionId])` to `JSON.stringify([identity.runtimeKey, identity.sessionId])`.
- `linkedReferenceDrafts.test.ts:62` composer reference chips > deleting a draft drops its chips and keeps its neighbour: `linkedReferenceDrafts.ts`. Kept unchanged; red after `!target` to `!(!target)`.
- `linkedReferenceDrafts.test.ts:74` composer reference chips > a composer without a draft identity holds no chips: `linkedReferenceDrafts.ts`. Kept unchanged; red after `NO_REFERENCES` to `''`.
- `linkedReferenceDrafts.test.ts:79` composer reference chips > moving chips merges additions at both identities and keeps the destination snapshot: `composerReferences.ts`. Kept unchanged; red after `1` to `0`.

## pastedSessionIds.test.ts

- `pastedSessionIds.test.ts:32` pasted session ids > finds the id inside the pasted whitespace: `pastedSessionIds.ts`. Kept unchanged; red after `fromValueProp` to `!(fromValueProp)`.
- `pastedSessionIds.test.ts:37` pasted session ids > follows text added before the id while the session is read: `pastedSessionIds.ts`. Kept unchanged; red after `landed` to `!(landed)`.
- `pastedSessionIds.test.ts:48` pasted session ids > keeps a caret that moved before the id where it is: `pastedSessionIds.ts`. Kept unchanged; red after `value.slice(range.from, range.to) !== range.sessionId` to `!(value.slice(range.from, range.to) !== range.sessionId)`.
- `pastedSessionIds.test.ts:53` pasted session ids > leaves an id the user changed as text: `pastedSessionIds.ts`. Kept unchanged; red after `value.slice(range.from, range.to) !== range.sessionId` to `!(value.slice(range.from, range.to) !== range.sessionId)`.
- `pastedSessionIds.test.ts:59` pasted session ids > leaves an id the user deleted: `pastedSessionIds.ts`. Kept unchanged; red after `value.slice(range.from, range.to) !== range.sessionId` to `!(value.slice(range.from, range.to) !== range.sessionId)`.
- `pastedSessionIds.test.ts:65` pasted session ids > leaves an id that now runs into a typed word as text: `pastedSessionIds.ts`. Kept unchanged; red after `!findSessionLinks(next, ownOrigins).some((found) => found.start === range.from && found.link === link)` to `!(!findSessionLinks(next, ownOrigins).some((found) => found.start === range.from && found.link === link))`.
- `pastedSessionIds.test.ts:71` pasted session ids > leaves an id pasted into an address alone: `pastedSessionIds.ts`. Kept unchanged; red after `!findSessionLinks(next, ownOrigins).some((found) => found.start === range.from && found.link === link)` to `!(!findSessionLinks(next, ownOrigins).some((found) => found.start === range.from && found.link === link))`.
- `pastedSessionIds.test.ts:77` pasted session ids > forgets every id when the app sets other text: `pastedSessionIds.ts`. Kept unchanged; red after `fromValueProp` to `!(fromValueProp)`.
- `pastedSessionIds.test.ts:84` pasted session ids > an expected id does not outlive the edit after it: `pastedSessionIds.ts`. Kept unchanged; red after `!sessionId \|\| !fromPaste` to `!(!sessionId \|\| !fromPaste)`.

## pendingComposerReferences.test.ts

- `pendingComposerReferences.test.ts:29` pending composer references > a session handoff waits for that session and is not taken by another: `pendingComposerReferences.ts`. Kept unchanged; red after `a.kind === 'session'` to `!(a.kind === 'session')`.
- `pendingComposerReferences.test.ts:38` pending composer references > a draft handoff is not taken by a session composer: `pendingComposerReferences.ts`. Kept unchanged; red after `b.kind !== 'draft'` to `!(b.kind !== 'draft')`.
- `pendingComposerReferences.test.ts:45` pending composer references > a named draft keeps its handoff for that draft: `pendingComposerReferences.ts`. Kept unchanged; red after `b.kind !== 'draft'` to `!(b.kind !== 'draft')`.
- `pendingComposerReferences.test.ts:53` pending composer references > two handoffs keep their own references: `pendingComposerReferences.ts`. Kept unchanged; red after `a.kind === 'session'` to `!(a.kind === 'session')`.
- `pendingComposerReferences.test.ts:61` pending composer references > a session handoff cannot be taken by a draft composer: `pendingComposerReferences.ts`. Kept unchanged; red after `a.kind === 'session'` to `!(a.kind === 'session')`.
- `pendingComposerReferences.test.ts:78` composer handoff target > a session composer takes the session target: `pendingComposerReferences.ts`. Kept unchanged; red after `input.currentSessionId` to `!(input.currentSessionId)`.
- `pendingComposerReferences.test.ts:82` composer handoff target > a draft composer takes the draft target: `pendingComposerReferences.ts`. Kept unchanged; red after `input.currentSessionId` to `!(input.currentSessionId)`.
- `pendingComposerReferences.test.ts:91` composer handoff target > a pinned composer takes nothing: `pendingComposerReferences.ts`. Kept unchanged; red after `input.columnPinned \|\| input.btwActive` to `!(input.columnPinned \|\| input.btwActive)`.
- `pendingComposerReferences.test.ts:95` composer handoff target > an expanded /btw panel takes nothing, even with a session: `pendingComposerReferences.ts`. Kept unchanged; red after `input.columnPinned \|\| input.btwActive` to `!(input.columnPinned \|\| input.btwActive)`.
- `pendingComposerReferences.test.ts:99` composer handoff target > no session and no draft takes nothing: `pendingComposerReferences.ts`. Kept unchanged; red after `input.currentSessionId` to `!(input.currentSessionId)`.
- `pendingComposerReferences.test.ts:103` composer handoff target > a draft without an identity takes nothing: `pendingComposerReferences.ts`. Kept unchanged; red after `input.currentSessionId` to `!(input.currentSessionId)`.

## referenceLinks.test.ts

- `referenceLinks.test.ts:19` findReferenceLinks > finds issue, change request and tracker links, once each, without the punctuation after them: `referenceLinks.ts`. Kept unchanged; red after `seen.has(link)` to `!(seen.has(link))`.
- `referenceLinks.test.ts:42` findReferenceLinks > leaves other links and discussions as text: `referenceLinks.ts`. Kept unchanged; red after `target` to `!(target)`.
- `referenceLinks.test.ts:49` referenceLinksInText > sends what the text still links, once each: `referenceLinks.ts`. Kept unchanged; red after `read.size === 0` to `!(read.size === 0)`.
- `referenceLinks.test.ts:57` referenceLinkChip > labels a chip with the number and title the host writes: `referenceLinks.ts`. Kept unchanged; red after `reference.kind === 'shared-page'` to `!(reference.kind === 'shared-page')`.
- `referenceLinks.test.ts:74` items as links in the composer text > an item goes only while the text holds its link: `referenceLinks.ts`. Kept unchanged; red after `!text.includes('http')` to `!(!text.includes('http'))`.
- `referenceLinks.test.ts:78` items as links in the composer text > putting items back appends the links the text lacks: `referenceLinks.ts`. Kept unchanged; red after `!text.includes('http')` to `!(!text.includes('http'))`.
- `referenceLinks.test.ts:83` items as links in the composer text > a page chip built before pages had their link falls back to its host and id: `referenceLinks.ts`. Kept unchanged; red after `reference.kind !== 'shared-page'` to `!(reference.kind !== 'shared-page')`.
- `referenceLinks.test.ts:87` items as links in the composer text > a shared page leaves the sent text, the rest stays: `referenceLinks.ts`. Kept unchanged; red after `reference.kind !== 'shared-page'` to `!(reference.kind !== 'shared-page')`.

## sessionReferences.test.ts

- `sessionReferences.test.ts:15` session references > a mentioned session names itself and how to read it, with no request attached: `sessionReferences.ts`. Kept unchanged; red after `         + ` to ` - `.
- `sessionReferences.test.ts:21` session references > a message goes whole: its own text, never attached context or tool output, and no cut: `sessionReferences.ts`. Kept unchanged; red after `role === 'user'` to `!(role === 'user')`.
- `sessionReferences.test.ts:33` session references > the text decides what goes: each mention once, in order, and what is not resolved yet: `sessionReferences.ts`. Kept unchanged; red after `seen.has(key)` to `!(seen.has(key))`.
- `sessionReferences.test.ts:44` session references > a message link whose message had no text keeps its own key, so it still finds its chip: `sessionReferences.ts`. Kept unchanged; red after `reference` to `!(reference)`.

## sharedPageChipDrafts.test.ts

- `sharedPageChipDrafts.test.ts:18` page chips kept across reloads > keep only what names the page, and come back to be opened again from the server: `sharedPageChipDrafts.ts`. Kept unchanged; red after `!chip.success` to `!(!chip.success)`.
- `sharedPageChipDrafts.test.ts:29` page chips kept across reloads > read nothing from storage they cannot parse: `sharedPageChipDrafts.ts`. Kept unchanged; red after `chips.length > 0` to `!(chips.length > 0)`.

## state/__tests__/promptHistorySearch.test.ts

- `state/__tests__/promptHistorySearch.test.ts:11` preparePromptHistory > keeps newest exact-text entries in oldest-first order with original indices: `state/promptHistorySearch.ts`. Kept unchanged; red after `!value.text.trim() \|\| newestByText.has(value.text)` to `!(!value.text.trim() \|\| newestByText.has(value.text))`.
- `state/__tests__/promptHistorySearch.test.ts:21` preparePromptHistory > does not treat whitespace-only prompts as candidates: `state/promptHistorySearch.ts`. Kept unchanged; red after `!value.text.trim() \|\| newestByText.has(value.text)` to `!(!value.text.trim() \|\| newestByText.has(value.text))`.
- `state/__tests__/promptHistorySearch.test.ts:37` filterPromptHistory > preserves chronology while matching all case-insensitive query tokens: `state/promptHistorySearch.ts`. Kept unchanged; red after `!value.text.trim() \|\| newestByText.has(value.text)` to `!(!value.text.trim() \|\| newestByText.has(value.text))`.
- `state/__tests__/promptHistorySearch.test.ts:41` filterPromptHistory > uses punctuation-insensitive matching without typo fallback: `state/promptHistorySearch.ts`. Kept unchanged; red after `!value.text.trim() \|\| newestByText.has(value.text)` to `!(!value.text.trim() \|\| newestByText.has(value.text))`.
- `state/__tests__/promptHistorySearch.test.ts:46` filterPromptHistory > matches Unicode and text beyond a preview-sized prefix: `state/promptHistorySearch.ts`. Kept unchanged; red after `!value.text.trim() \|\| newestByText.has(value.text)` to `!(!value.text.trim() \|\| newestByText.has(value.text))`.

## state/__tests__/useComposerDraft.btwPending.test.ts

- `state/__tests__/useComposerDraft.btwPending.test.ts:74` /btw fork still being created > discard clears pending memory so a repeated /btw starts empty: `state/useComposerDraft.ts`. Kept unchanged; red after `draftMemoryRef.current.set(deletedKey, { text: '', confirmedMentions: new Set() });` to `;`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:88` /btw fork still being created > keeps text across a switch to parent before migration to the fork: `state/useComposerDraft.ts`. Kept unchanged; red after `from` to `!(from)`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:88` /btw fork still being created > keeps text across a switch to another-chat before migration to the fork: `state/useComposerDraft.ts`. Kept unchanged; red after `from` to `!(from)`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:105` /btw fork still being created > failure recovery stays in memory and survives collapse: `state/useComposerDraft.ts`. Kept unchanged; red after `text.get()` to `''`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:119` /btw fork still being created > restores a failed question to its pending owner after navigation: `state/useComposerDraft.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `state/__tests__/useComposerDraft.btwPending.test.ts:133` /btw fork still being created > a By the way handoff and recovery never persist the pending key: `state/useComposerDraft.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `state/__tests__/useComposerDraft.btwPending.test.ts:149` /btw fork still being created > keeps nothing under its placeholder identity: `state/useComposerDraft.ts`. Kept unchanged; red after `isBtwPendingComposerKey(target.sessionId)` to `!(isBtwPendingComposerKey(target.sessionId))`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:160` /btw fork still being created > carries the draft to the fork instead of leaving a copy behind: `state/useComposerDraft.ts`. Kept unchanged; red after `text.get()` to `''`.
- `state/__tests__/useComposerDraft.btwPending.test.ts:176` /btw fork still being created > ignores a placeholder draft an older build left in storage: `state/useComposerDraft.ts`. Deleted after 2 green mutations: `identity && isBtwPendingComposerKey(identity.sessionId)` to `identity && !isBtwPendingComposerKey(identity.sessionId)`; `? { text: '', confirmedMentions: new Set<string>() }                 : readChatDraftClaimingFolderDraft(identity)` to `? readChatDraftClaimingFolderDraft(identity)                 : readChatDraftClaimingFolderDraft(identity)`.

## state/__tests__/useComposerDraft.fork.test.ts

- `state/__tests__/useComposerDraft.fork.test.ts:85` fork composer restoration > waits for the rendered fork and preserves the source: `state/useComposerDraft.ts`. Kept unchanged; red after `initialKey && !draftMemoryRef.current.has(initialKey) && initialDraft.text` to `!(initialKey && !draftMemoryRef.current.has(initialKey) && initialDraft.text)`.
- `state/__tests__/useComposerDraft.fork.test.ts:119` fork composer restoration > waits through unrelated session, directory, and runtime renders: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.fork.test.ts:142` fork composer restoration > persists a replay even when its text equals the outgoing source draft: `state/useComposerDraft.ts`. Kept unchanged; red after `persistNow(pending.target, text);` to `;`.
- `state/__tests__/useComposerDraft.fork.test.ts:158` fork composer restoration > restores file-only and empty prompts without keeping destination text or files, a file as its chip: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.fork.test.ts:181` attachment draft ownership > keeps images and files with their draft: `state/useComposerDraft.ts`. Kept unchanged; red after `!selectAttachmentsOnIdentityChange` to `!(!selectAttachmentsOnIdentityChange)`.
- `state/__tests__/useComposerDraft.fork.test.ts:222` attachment draft ownership > retains attachments across composer remounts: `state/useComposerDraft.ts`. Kept unchanged; red after `!selectAttachmentsOnIdentityChange` to `!(!selectAttachmentsOnIdentityChange)`.
- `state/__tests__/useComposerDraft.fork.test.ts:238` attachment draft ownership > restores a failed send to its source and clears deleted drafts: `state/useComposerDraft.ts`. Kept unchanged; red after `!selectAttachmentsOnIdentityChange` to `!(!selectAttachmentsOnIdentityChange)`.

## state/__tests__/useComposerDraft.retarget.test.ts

- `state/__tests__/useComposerDraft.retarget.test.ts:91` new-session draft changing its directory > takes the typed text and files along and leaves nothing behind: `linkedReferenceDrafts.ts`. Kept unchanged; red after `!from \|\| !to` to `!(!from \|\| !to)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:124` new-session draft changing its directory > keeps a draft already saved for the new directory above the typed text: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:136` new-session draft changing its directory > an empty draft still restores what the new directory had: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:149` new-session draft changing its directory > switching to a session keeps the drafts apart: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:161` new-session draft changing its directory > a new chat opened in another directory leaves the typed text where it was: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:179` new-session draft changing its directory > attached files move even without text: `linkedReferenceDrafts.ts`. Kept unchanged; red after `!from \|\| !to` to `!(!from \|\| !to)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:199` session moved to another directory > takes the typed text and files along and leaves nothing behind: `linkedReferenceDrafts.ts`. Kept unchanged; red after `!from \|\| !to` to `!(!from \|\| !to)`.
- `state/__tests__/useComposerDraft.retarget.test.ts:227` session moved to another directory > another session keeps its own draft: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.

## state/__tests__/useDictationOrigin.test.ts

- `state/__tests__/useDictationOrigin.test.ts:75` dictation origin > a transcript for the rendered draft is left to the composer: `state/useDictationOrigin.ts`. Kept unchanged; red after `current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(origin)` to `!(current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(origin))`.
- `state/__tests__/useDictationOrigin.test.ts:91` dictation origin > a session switch keeps the transcript out of the visible composer: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/useDictationOrigin.test.ts:115` dictation origin > the transcript is appended to text already drafted in the originating session: `state/useDictationOrigin.ts`. Kept unchanged; red after `!origin \|\| !text.trim()` to `!(!origin \|\| !text.trim())`.
- `state/__tests__/useDictationOrigin.test.ts:129` dictation origin > an origin is used once, so a later transcript follows the rendered draft: `state/useDictationOrigin.ts`. Kept unchanged; red after `!origin \|\| !text.trim()` to `!(!origin \|\| !text.trim())`.

## state/__tests__/useDraftTarget.pinnedDirectory.test.tsx

- `state/__tests__/useDraftTarget.pinnedDirectory.test.tsx:76` useDraftTarget with a pinned draft directory > picking another project moves the draft and clears the pin: `state/useDraftTarget.ts`. Kept unchanged; red after `store.newSessionDraft?.preserveDirectoryOverride` to `!(store.newSessionDraft?.preserveDirectoryOverride)`.
- `state/__tests__/useDraftTarget.pinnedDirectory.test.tsx:88` useDraftTarget with a pinned draft directory > picking another directory moves the draft and clears the pin: `state/useDraftTarget.ts`. Kept unchanged; red after `newSessionDraft?.target === 'chat'` to `!(newSessionDraft?.target === 'chat')`.
- `state/__tests__/useDraftTarget.pinnedDirectory.test.tsx:100` useDraftTarget with a pinned draft directory > re-picking the shown project or directory keeps the pin: `state/useDraftTarget.ts`. Kept unchanged; red after `newSessionDraft?.target === 'chat'` to `!(newSessionDraft?.target === 'chat')`.
- `state/__tests__/useDraftTarget.pinnedDirectory.test.tsx:113` useDraftTarget with a pinned draft directory > a worktree still being created keeps the draft where it is: `state/useDraftTarget.ts`. Kept unchanged; red after `!selectedDraftProjectCurrentBranch` to `!(!selectedDraftProjectCurrentBranch)`.

## state/__tests__/useDraftTarget.refresh.test.tsx

- `state/__tests__/useDraftTarget.refresh.test.tsx:29` useDraftTarget refresh > refreshes a fresh cached branch list when the window regains focus: `state/useDraftTarget.ts`. Kept unchanged; red after `newSessionDraft?.target === 'chat'` to `!(newSessionDraft?.target === 'chat')`.
- `state/__tests__/useDraftTarget.refresh.test.tsx:126` useDraftTarget refresh > leaves the target alone while a worktree is being created: `state/useDraftTarget.ts`. Kept unchanged; red after `selectedDraftProjectPath` to `!(selectedDraftProjectPath)`.

## state/__tests__/useDraftTarget.worktreeBootstrap.test.tsx

- `state/__tests__/useDraftTarget.worktreeBootstrap.test.tsx:30` useDraftTarget while a new worktree attaches > keeps the selected worktree listed until its bootstrap settles, without rewriting the draft: `state/useDraftTarget.ts`. Kept unchanged; red after `!selectedDraftDirectory` to `!(!selectedDraftDirectory)`.

## state/__tests__/useMessageHistory.test.ts

- `state/__tests__/useMessageHistory.test.ts:158` message history cursor model > uses a 0..history.length cursor with the draft at the endpoint: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.
- `state/__tests__/useMessageHistory.test.ts:175` message history cursor model > clamps at both ends: `state/useMessageHistory.ts`. Kept unchanged; red after `history.length === 0 \|\| state.cursor === 0` to `!(history.length === 0 \|\| state.cursor === 0)`.
- `state/__tests__/useMessageHistory.test.ts:188` message history cursor model > restores an empty draft when the user returns to the endpoint: `state/useMessageHistory.ts`. Kept unchanged; red after `history.length === 0 \|\| state.cursor === 0` to `!(history.length === 0 \|\| state.cursor === 0)`.
- `state/__tests__/useMessageHistory.test.ts:199` message history overlays > restores edited text for recalled entries and the original draft: `state/useMessageHistory.ts`. Kept unchanged; red after `overlay` to `!(overlay)`.
- `state/__tests__/useMessageHistory.test.ts:211` message history overlays > restores edited attachments for recalled entries and the draft endpoint: `state/useMessageHistory.ts`. Kept unchanged; red after `overlay` to `!(overlay)`.
- `state/__tests__/useMessageHistory.test.ts:225` message history overlays > reset clears overlays and returns to the draft endpoint: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.
- `state/__tests__/useMessageHistory.test.ts:242` message history direct selection > loads the raw selected entry and replaces an edit at the same position: `state/useMessageHistory.ts`. Kept unchanged; red after `!Object.is(a.attachments[index], b.attachments[index])` to `!(!Object.is(a.attachments[index], b.attachments[index]))`.
- `state/__tests__/useMessageHistory.test.ts:262` message history direct selection > preserves the live draft and unrelated recalled edits when jumping: `state/useMessageHistory.ts`. Kept unchanged; red after `a.text !== b.text` to `!(a.text !== b.text)`.
- `state/__tests__/useMessageHistory.test.ts:281` message history direct selection > does not select a stale or invalid history entry: `state/useMessageHistory.ts`. Kept unchanged; red after `a.text !== b.text` to `!(a.text !== b.text)`.
- `state/__tests__/useMessageHistory.test.ts:294` message history direct selection > synchronizes trimmed history before selecting its current index: `state/useMessageHistory.ts`. Kept unchanged; red after `a.text !== b.text` to `!(a.text !== b.text)`.
- `state/__tests__/useMessageHistory.test.ts:307` message history synchronization > resets when the active identity changes: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.
- `state/__tests__/useMessageHistory.test.ts:321` message history synchronization > reset after send drops stale overlays before the sent message is appended: `state/useMessageHistory.ts`. Kept unchanged; red after `oldCursor === oldLength` to `!(oldCursor === oldLength)`.
- `state/__tests__/useMessageHistory.test.ts:335` message history synchronization > tracks an external append while the user stays at the endpoint: `state/useMessageHistory.ts`. Kept unchanged; red after `oldCursor === oldLength` to `!(oldCursor === oldLength)`.
- `state/__tests__/useMessageHistory.test.ts:344` message history synchronization > keeps the same logical entry selected while browsing during an external append: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === oldLength` to `!(cursor === oldLength)`.
- `state/__tests__/useMessageHistory.test.ts:357` message history synchronization > preserves the current logical entry when a 40-entry bucket trims its oldest value: `state/useMessageHistory.ts`. Kept unchanged; red after `oldCursor < trimmed` to `!(oldCursor < trimmed)`.
- `state/__tests__/useMessageHistory.test.ts:373` useMessageHistory > synchronizes identity and history before jumping to an expected entry: `state/useMessageHistory.ts`. Kept unchanged; red after `a.text !== b.text` to `!(a.text !== b.text)`.
- `state/__tests__/useMessageHistory.test.ts:392` useMessageHistory > round-trips edited recalled entries and the live draft through the generic API: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.
- `state/__tests__/useMessageHistory.test.ts:427` useMessageHistory > reset exits browsing and drops stale overlays: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.
- `state/__tests__/useMessageHistory.test.ts:463` useMessageHistory > resets browsing when the identity changes: `state/useMessageHistory.ts`. Kept unchanged; red after `cursor === history.length` to `!(cursor === history.length)`.

## state/__tests__/useMobileViewportPin.test.tsx

- `state/__tests__/useMobileViewportPin.test.tsx:140` useMobileViewportPin > lifts the composer above the software keyboard as soon as it has focus: `state/useMobileViewportPin.ts`. Kept unchanged; red after `now < activeUntil` to `!(now < activeUntil)`.
- `state/__tests__/useMobileViewportPin.test.tsx:161` useMobileViewportPin > leaves the composer in place when no keyboard covers it: `state/useMobileViewportPin.ts`. Kept unchanged; red after `!isMobile \|\| !isFullscreen \|\| isCapacitorApp()` to `!(!isMobile \|\| !isFullscreen \|\| isCapacitorApp())`.
- `state/__tests__/useMobileViewportPin.test.tsx:172` useMobileViewportPin > leaves an expanded composer in place when it cannot fit above the keyboard: `state/useMobileViewportPin.ts`. Kept unchanged; red after `!isMobile \|\| !isFullscreen \|\| isCapacitorApp()` to `!(!isMobile \|\| !isFullscreen \|\| isCapacitorApp())`.
- `state/__tests__/useMobileViewportPin.test.tsx:184` useMobileViewportPin > changes nothing in a Safari tab or on a Mac: `state/useMobileViewportPin.ts`. Kept unchanged; red after `!isMobile \|\| !isFullscreen \|\| isCapacitorApp()` to `!(!isMobile \|\| !isFullscreen \|\| isCapacitorApp())`.
- `state/__tests__/useMobileViewportPin.test.tsx:204` useMobileViewportPin > stops measuring every frame once the keyboard holds still, and still follows a silent move: `state/useMobileViewportPin.ts`. Kept unchanged; red after `measure()` to `!(measure())`.
- `state/__tests__/useMobileViewportPin.test.tsx:232` useMobileViewportPin > a tap on the composer brings the frames back at once: `state/useMobileViewportPin.ts`. Kept unchanged; red after `measure()` to `!(measure())`.
- `state/__tests__/useMobileViewportPin.test.tsx:250` useMobileViewportPin > clears the lift and schedules nothing once focus leaves the iPad composer: `state/useMobileViewportPin.ts`. Kept unchanged; red after `measure()` to `!(measure())`.
- `state/__tests__/useMobileViewportPin.test.tsx:267` useMobileViewportPin > measures nothing on the iPad while the composer has no focus: `state/useMobileViewportPin.ts`. Kept unchanged; red after `!running` to `!(!running)`.
- `state/__tests__/useMobileViewportPin.test.tsx:277` useMobileViewportPin > settles the phone draft screen pin the same way: `state/useMobileViewportPin.ts`. Kept unchanged; red after `measure()` to `!(measure())`.

## state/__tests__/usePendingComposerText.slashCommand.test.tsx

- `state/__tests__/usePendingComposerText.slashCommand.test.tsx:50`  > a slash command waits while the composer holds it, then starts the draft and leaves shell mode: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/usePendingComposerText.slashCommand.test.tsx:68`  > other pending text is not held: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.

## state/__tests__/usePendingComposerText.test.tsx

- `state/__tests__/usePendingComposerText.test.tsx:82` pending composer text > waits for the main column to show a new draft opened with a prompt: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/usePendingComposerText.test.tsx:103` pending composer text > takes text at once when the column already shows the selection: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/usePendingComposerText.test.tsx:114` pending composer text > a pinned column takes its own text while the main chat is elsewhere: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/usePendingComposerText.test.tsx:126` pending composer text > a composer on a /btw fork takes the chat text and leaves another session's restore waiting: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.
- `state/__tests__/usePendingComposerText.test.tsx:160` pending composer text > a pinned fork takes column quotes but leaves the parent restore until collapse: `state/composerText.ts`. Kept unchanged; red after `next === text` to `!(next === text)`.

## state/abortShortcutReach.test.ts

- `state/abortShortcutReach.test.ts:6` abortShortcutReachesComposer > only a chat composer in a window wired to double Escape, used with a keyboard: `state/abortShortcutReach.ts`. Kept unchanged; red after ` \|\| ` to ` && `.

## state/composerInsetReaders.test.ts

- `state/composerInsetReaders.test.ts:58` composer inset readers > writes the insets onto the readers, never onto the column or the transcript: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:73` composer inset readers > a reader mounted after the column published takes its current values: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:80` composer inset readers > readers of another column are left alone: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:93` composer inset readers > withdrawing returns the readers to their CSS fallbacks: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:103` composer inset readers > a released reader is no longer written: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:112` composer inset readers > the floating panel clearance goes onto its readers, never onto the column or the transcript: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:129` composer inset readers > a held reserve reaches the tail spacer while the overlays follow the real clearance: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:144` composer inset readers > a clearance reader mounted while a panel is docked takes its clearance: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `state/composerInsetReaders.test.ts:153` composer inset readers > the clearance and the insets publish and withdraw independently: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.

## state/composerTailInset.test.ts

- `state/composerTailInset.test.ts:6` resolveComposerTailInset > a resting composer reserves its height plus the gap: `state/composerTailInset.ts`. Kept unchanged; red after ` + ` to ` - `.
- `state/composerTailInset.test.ts:10` resolveComposerTailInset > growth within the allowance keeps the transcript end in place: `state/composerTailInset.ts`. Kept unchanged; red after ` + ` to ` - `.
- `state/composerTailInset.test.ts:15` resolveComposerTailInset > growth past the allowance pushes the end by the excess only: `state/composerTailInset.ts`. Kept unchanged; red after ` + ` to ` - `.
- `state/composerTailInset.test.ts:19` resolveComposerTailInset > a pill-to-composer swap moves the end by the inset change, not the slot change: `state/composerTailInset.ts`. Kept unchanged; red after ` + ` to ` - `.
- `state/composerTailInset.test.ts:28` recordComposerSlotHeight > a read-only banner in the slot never becomes the resting height: `state/composerTailInset.ts`. Kept unchanged; red after `true` to `false`.
- `state/composerTailInset.test.ts:38` recordComposerSlotHeight > a pinned slot taller than the resting composer is grown, without moving the floor: `state/composerTailInset.ts`. Kept unchanged; red after `previous === undefined` to `!(previous === undefined)`.

## state/promptHistorySearchRoute.test.ts

- `state/promptHistorySearchRoute.test.ts:11`  > routes a DOM keyboard event to its focused composer and unregisters its owner: `state/promptHistorySearchRoute.ts`. Kept unchanged; red after `!(target instanceof Element)` to `!(!(target instanceof Element))`.

## submit/__tests__/buildOutgoingMessage.test.ts

- `submit/__tests__/buildOutgoingMessage.test.ts:54` a share link in the text > leaves without its key, in the composer text and in queued text: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `addText(resolved.text);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:63` the composer text alone > becomes the primary message: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `submit/__tests__/buildOutgoingMessage.test.ts:70` the composer text alone > surrounding blank lines are trimmed: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `addText(resolved.text);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:75` the composer text alone > interior blank lines are preserved: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `addText(resolved.text);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:80` the composer text alone > its attachments and resolved file mentions travel with it: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `primaryAttachments.push(             ...deps.sanitizeAttachments(input.composerAttachments),             ...resolved.attachments,         );` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:88` the composer text alone > nothing at all is empty: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/buildOutgoingMessage.test.ts:104` manual queue projection > a scheduled head with inherited selection does not supply config or text to mixed send-all: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `messages.filter((message) => !message.scheduledTask)` to `messages`.
- `submit/__tests__/buildOutgoingMessage.test.ts:104` manual queue projection > a scheduled head with explicit selection does not supply config or text to mixed send-all: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `messages.filter((message) => !message.scheduledTask)` to `messages`.
- `submit/__tests__/buildOutgoingMessage.test.ts:114` manual queue projection > a scheduled-only queue has no manual sendable content: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `messages.filter((message) => !message.scheduledTask)` to `messages`.
- `submit/__tests__/buildOutgoingMessage.test.ts:121` manual queue projection > ordinary queues keep their original items, order and identity: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `messages.some((message) => message.scheduledTask)` to `!(messages.some((message) => message.scheduledTask))`.
- `submit/__tests__/buildOutgoingMessage.test.ts:128` queued messages > all of them share the visible message, oldest first: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `addText(queued.text);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:136` queued messages > the composer text lands after everything queued: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `addText(queued.text);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:145` queued messages > an attachment-only queued message adds no blank paragraph: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `primaryAttachments.push(...deps.sanitizeAttachments(queued.attachments));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:154` queued messages > the context each message was queued with is sent in queue order: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `additionalParts.push(...queuedContextToParts(queued.context ?? []));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:169` queued messages > a queued message is placed as captured, never re-resolved: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `let agentMentionName: string \| undefined;` to `let agentMentionName: string \| undefined = '';`.
- `submit/__tests__/buildOutgoingMessage.test.ts:179` queued messages > every attachment rides the visible message, in order: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `primaryAttachments.push(...deps.sanitizeAttachments(queued.attachments));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:194` agent mentions > an agent named in the composer routes the send: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `noteAgent(agent.agentName);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:199` agent mentions > the first mention wins across queued messages: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `submit/__tests__/buildOutgoingMessage.test.ts:206` agent mentions > a queued mention outranks one typed later: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` && ` to ` \|\| `.
- `submit/__tests__/buildOutgoingMessage.test.ts:214` agent mentions > no mention leaves the routing unset: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `let agentMentionName: string \| undefined;` to `let agentMentionName: string \| undefined = '';`.
- `submit/__tests__/buildOutgoingMessage.test.ts:236` context drafts > each becomes a synthetic part carrying structured metadata: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `attach(createContextPart(contextPayloadFromDraft(draft)));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:252` context drafts > context parts precede other synthetic context: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `attach(createContextPart(contextPayloadFromDraft(draft)));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:262` context drafts > no drafts changes nothing: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `skillInstruction` to `!(skillInstruction)`.
- `submit/__tests__/buildOutgoingMessage.test.ts:269` synthetic context > a linked PR is sent as its context only, with no instructions guessing the intent: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `'change-request'` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:281` synthetic context > a linked issue is sent as context: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `'repository-issue'` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:292` synthetic context > a linked tracker item is sent as context: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `'tracker-item'` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:303` synthetic context > a linked guest issue is sent as context: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `submit/__tests__/buildOutgoingMessage.test.ts:327` synthetic context > a linked guest issue keeps its opaque data in metadata only: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` !== ` to ` === `.
- `submit/__tests__/buildOutgoingMessage.test.ts:345` synthetic context > a linked guest pull is sent as guest-pr context: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `submit/__tests__/buildOutgoingMessage.test.ts:370` synthetic context > synthetic texts precede the linked references: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `context.push({ kind: 'synthetic', text });` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:381` synthetic context > skills named inline are reported, not turned into a part: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `skillNames.push(name);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:387` synthetic context > skills named in the composer are collected in order without duplicates: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `skillNames.push(name);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:394` synthetic context > queued text is not scanned again: its instruction was captured when it was queued: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `additionalParts.push(...queuedContextToParts(queued.context ?? []));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:403` synthetic context > context alone is still worth sending: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/buildOutgoingMessage.test.ts:410` synthetic context > attachments alone are worth sending: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `primaryAttachments.push(             ...deps.sanitizeAttachments(input.composerAttachments),             ...resolved.attachments,         );` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:420` several references > each becomes its own context part, in the order they were attached: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `attach(createContextPart(payload, contextText));` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:435` full assembly order > queued, then typed, then synthetic, then references: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `skillNames.push(name);` to `;`.
- `submit/__tests__/buildOutgoingMessage.test.ts:466` capturing composer context for the queue > captures everything attached, in send order, with the skill instruction last: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `'synthetic'` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:490` capturing composer context for the queue > a message queued with instructions before they were dropped still delivers them first: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `true` to `false`.
- `submit/__tests__/buildOutgoingMessage.test.ts:498` capturing composer context for the queue > nothing attached captures nothing: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `context` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:502` capturing composer context for the queue > delivering captured context reproduces the composer parts exactly: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `skillInstruction` to `''`.
- `submit/__tests__/buildOutgoingMessage.test.ts:535` the composer send gate counts what the submission builder counts > queue counts and captured configuration use the ordinary-only projection: `submit/buildOutgoingMessage.ts`. Deleted after 2 green mutations: `messages.filter((message) => !message.scheduledTask)` to `messages.filter((message) => Boolean(message.scheduledTask))`; `messages.filter((message) => !message.scheduledTask)` to `messages`.
- `submit/__tests__/buildOutgoingMessage.test.ts:547` the composer send gate counts what the submission builder counts > a linked item is its link in the text: the gates count the text, and only linked items go: `referenceLinks.ts`. Deleted after 2 green mutations: `return references.filter((reference) => links.has(referenceTextLink(reference)));` to `return references.filter((reference) => !links.has(referenceTextLink(reference)));`; `return references.filter((reference) => links.has(referenceTextLink(reference)));` to `return [...references];`.
- `submit/__tests__/buildOutgoingMessage.test.ts:560` the composer send gate counts what the submission builder counts > a linked reference on its own is a message, and nothing at all is still empty: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/buildOutgoingMessage.test.ts:594` expandCommentSnippets > expands the comment words and leaves the quote verbatim: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after `!draft.text` to `!(!draft.text)`.
- `submit/__tests__/buildOutgoingMessage.test.ts:600` expandCommentSnippets > keeps a comment as written when expansion fails: `submit/buildOutgoingMessage.ts`. Kept unchanged; red after ` === ` to ` !== `.

## submit/__tests__/forkCommand.test.ts

- `submit/__tests__/forkCommand.test.ts:38` runForkCommand > sends the text into the fork, not the source session: `submit/forkCommand.ts`. Kept unchanged; red after `'sent'` to `''`.
- `submit/__tests__/forkCommand.test.ts:44` runForkCommand > a bare /fork only opens the fork: `submit/forkCommand.ts`. Kept unchanged; red after `'forked'` to `''`.
- `submit/__tests__/forkCommand.test.ts:50` runForkCommand > a failed fork throws and sends nothing: `submit/forkCommand.ts`. Kept unchanged; red after `await deps.fork(sourceSessionId)` to `await deps.fork(sourceSessionId).catch(() => null)`.
- `submit/__tests__/forkCommand.test.ts:56` runForkCommand > a failed send puts the text into the fork composer: `submit/forkCommand.ts`. Kept unchanged; red after `target` to `!(target)`.
- `submit/__tests__/forkCommand.test.ts:62` runForkCommand > a runtime switch mid-fork stops before sending: `submit/forkCommand.ts`. Kept unchanged; red after `'stale'` to `''`.

## submit/__tests__/guestCommands.test.ts

- `submit/__tests__/guestCommands.test.ts:13` routeGuestSlashCommand > routes a guest command with its argument as typed: `submit/guestCommands.ts`. Kept unchanged; red after ` === ` to ` !== `.
- `submit/__tests__/guestCommands.test.ts:22` routeGuestSlashCommand > leaves everything else to the composer: `submit/guestCommands.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `submit/__tests__/guestCommands.test.ts:32` reservedComposerCommandNames > holds the composer commands and the OpenCode commands, lowercased: `submit/guestCommands.ts`. Kept unchanged; red after `names.add(command.name.toLowerCase());` to `;`.

## submit/__tests__/slashCommands.test.ts

- `submit/__tests__/slashCommands.test.ts:13` parseSlashCommand > reads a bare command: `submit/slashCommands.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/slashCommands.test.ts:17` parseSlashCommand > reads a command with an argument: `submit/slashCommands.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/slashCommands.test.ts:22` parseSlashCommand > leading whitespace is tolerated: `submit/slashCommands.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/slashCommands.test.ts:26` parseSlashCommand > the name is lowercased but the argument keeps its casing: `submit/slashCommands.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/slashCommands.test.ts:31` parseSlashCommand > a multi-line argument is preserved: `submit/slashCommands.ts`. Kept unchanged; red after `0` to `1`.
- `submit/__tests__/slashCommands.test.ts:36` parseSlashCommand > ordinary prose is not a command: `submit/slashCommands.ts`. Kept unchanged; red after `null` to `[]`.
- `submit/__tests__/slashCommands.test.ts:42` parseSlashCommand > a bare slash is not a command: `submit/slashCommands.ts`. Kept unchanged; red after `null` to `[]`.
- `submit/__tests__/slashCommands.test.ts:49` findMagicPromptCommand > finds a registered command: `submit/slashCommands.ts`. Kept unchanged; red after `'explore'` to `''`.
- `submit/__tests__/slashCommands.test.ts:53` findMagicPromptCommand > commands handled elsewhere are not prompt-pair commands: `submit/slashCommands.ts`. Kept unchanged; red after `COMMANDS_BY_NAME.get(name) ?? null` to `COMMANDS_BY_NAME.get(name) ?? MAGIC_PROMPT_COMMANDS[0]`.
- `submit/__tests__/slashCommands.test.ts:61` findMagicPromptCommand > an unknown name finds nothing: `submit/slashCommands.ts`. Kept unchanged; red after `COMMANDS_BY_NAME.get(name) ?? null` to `COMMANDS_BY_NAME.get(name) ?? MAGIC_PROMPT_COMMANDS[0]`.
- `submit/__tests__/slashCommands.test.ts:67` planLocalSlashCommand > /fork is a session action that keeps its text as the argument: `submit/slashCommands.ts`. Kept unchanged; red after `null` to `[]`.
- `submit/__tests__/slashCommands.test.ts:76` planLocalSlashCommand > an action command retains an attached inline comment: `submit/slashCommands.ts`. Kept unchanged; red after `'action'` to `''`.
- `submit/__tests__/slashCommands.test.ts:84` planLocalSlashCommand > prompt commands send attached context instead of disabling command parsing: `submit/slashCommands.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `submit/__tests__/slashCommands.test.ts:93` planLocalSlashCommand > session actions stay on the normal send path for a new-session draft: `submit/slashCommands.ts`. Kept unchanged; red after `null` to `[]`.
- `submit/__tests__/slashCommands.test.ts:99` planLocalSlashCommand > shell mode and server-owned commands stay outside local planning: `submit/slashCommands.ts`. Kept unchanged; red after `COMMANDS_BY_NAME.get(name) ?? null` to `COMMANDS_BY_NAME.get(name) ?? MAGIC_PROMPT_COMMANDS[0]`.
- `submit/__tests__/slashCommands.test.ts:109` canRunCommand > summarizing needs an existing conversation: `submit/slashCommands.ts`. Kept unchanged; red after `name: 'workspace-review',` to `name: 'summary',`.
- `submit/__tests__/slashCommands.test.ts:114` canRunCommand > most commands also run from a new-session draft: `submit/slashCommands.ts`. Kept unchanged; red after `: state.hasSession \|\| state.hasDraft;` to `: !(state.hasSession \|\| state.hasDraft);`.
- `submit/__tests__/slashCommands.test.ts:119` canRunCommand > nothing runs with neither: `submit/slashCommands.ts`. Kept unchanged; red after `: state.hasSession \|\| state.hasDraft;` to `: !(state.hasSession \|\| state.hasDraft);`.
- `submit/__tests__/slashCommands.test.ts:126` buildCommandVariables > a command without an argument contributes no variables: `submit/slashCommands.ts`. Kept unchanged; red after `visible: built.visible ?? {},` to `visible: built.visible ?? { argument },`.
- `submit/__tests__/slashCommands.test.ts:131` buildCommandVariables > a summary topic reaches both prompts: `submit/slashCommands.ts`. Kept unchanged; red after `name: 'workspace-review',` to `name: 'summary',`.
- `submit/__tests__/slashCommands.test.ts:137` buildCommandVariables > an absent summary topic leaves both slots blank, not "undefined": `submit/slashCommands.ts`. Kept unchanged; red after `name: 'workspace-review',` to `name: 'summary',`.
- `submit/__tests__/slashCommands.test.ts:143` buildCommandVariables > an idea is formatted as its own block: `submit/slashCommands.ts`. Kept unchanged; red after `idea` to `!(idea)`.
- `submit/__tests__/slashCommands.test.ts:148` buildCommandVariables > an absent idea leaves the slot blank: `submit/slashCommands.ts`. Kept unchanged; red after `idea` to `!(idea)`.
- `submit/__tests__/slashCommands.test.ts:155` the command table > names are unique: `submit/slashCommands.ts`. Kept unchanged; red after `name: 'workspace-review',` to `name: 'summary',`.
- `submit/__tests__/slashCommands.test.ts:160` the command table > every command names both prompts and a failure toast: `submit/slashCommands.ts`. Kept unchanged; red after `'session.plan.visible'` to `''`.

## ui/ComposerActionButtons.test.tsx

- `ui/ComposerActionButtons.test.tsx:82` ComposerActionButtons > a draft typed during a run turns the one disc into Send, which queues when follow-ups queue: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `isMobile \|\| followUp` to `!(isMobile \|\| followUp)`.
- `ui/ComposerActionButtons.test.tsx:93` ComposerActionButtons > the same disc steers when follow-ups steer: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `!isMobile && !followUp` to `!(!isMobile && !followUp)`.
- `ui/ComposerActionButtons.test.tsx:101` ComposerActionButtons > a run with an empty input shows Stop in the disc: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `canAbort && !hasContent` to `!(canAbort && !hasContent)`.
- `ui/ComposerActionButtons.test.tsx:111` ComposerActionButtons > with something to send the disc is the full one; with nothing it is the quiet one: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:125` ComposerActionButtons > Send, its follow-up and Stop share one 28px slot on desktop, whatever size the footer's other buttons have: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp && !escapeStops` to `!(followUp && !escapeStops)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on main desktop: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on Mini Chat: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on BTW: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on touch-only desktop: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on phone: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.
- `ui/ComposerActionButtons.test.tsx:152` ComposerActionButtons > running with a draft on a surface not wired yet: stoppable with the draft kept: `ui/ComposerActionButtons.tsx`. Kept unchanged; red after `followUp` to `!(followUp)`.

## ui/DraftTargetSelectors.test.tsx

- `ui/DraftTargetSelectors.test.tsx:62` draft worktree actions > offer a quick worktree and the dialog, and the dialog entry closes the sheet: `ui/DraftTargetSelectors.tsx`. Kept unchanged; red after `{onCreateCustomWorktree ? (                                     <MobileSheetRow` to `{!onCreateCustomWorktree ? (                                     <MobileSheetRow`.
- `ui/DraftTargetSelectors.test.tsx:74` draft worktree actions > leave the dialog entry out where the draft cannot open it: `ui/DraftTargetSelectors.tsx`. Kept unchanged; red after `{onCreateCustomWorktree ? (                                     <MobileSheetRow` to `{!onCreateCustomWorktree ? (                                     <MobileSheetRow`.
- `ui/DraftTargetSelectors.test.tsx:83` draft project picker > ends with Add project…, which closes the sheet and asks for a folder: `ui/DraftTargetSelectors.tsx`. Kept unchanged; red after `{onCreateCustomWorktree ? (                                     <MobileSheetRow` to `{!onCreateCustomWorktree ? (                                     <MobileSheetRow`.

## ui/LargeTextPasteChoice.test.tsx

- `ui/LargeTextPasteChoice.test.tsx:64` LargeTextPasteChoice > takes focus on "attach" and Enter picks it: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:72` LargeTextPasteChoice > arrows and Tab switch between the two options: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:83` LargeTextPasteChoice > Escape pastes inline: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:89` LargeTextPasteChoice > a printable key types through; shortcuts do not: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:99` LargeTextPasteChoice > focus moving elsewhere pastes inline without counting as an answer: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:105` LargeTextPasteChoice > on mobile it leaves focus where it was: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `if (takeFocus) attachRef.current?.focus({ preventScroll: true });` to `if (!takeFocus) attachRef.current?.focus({ preventScroll: true });`.
- `ui/LargeTextPasteChoice.test.tsx:111` LargeTextPasteChoice > an expanded composer anchors the pill inside its top edge: `ui/LargeTextPasteChoice.tsx`. Kept unchanged; red after `expanded` to `!(expanded)`.

## ui/MobilePillComposer.test.tsx

- `ui/MobilePillComposer.test.tsx:79` MobilePillComposer > uses the inline action to send content while the session is idle: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canAbort && queuesFollowUp` to `!(canAbort && queuesFollowUp)`.
- `ui/MobilePillComposer.test.tsx:86` MobilePillComposer > a draft typed during a run makes the disc Send, which queues, with a bare Stop before it: a phone has no Escape: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `hasContent` to `!(hasContent)`.
- `ui/MobilePillComposer.test.tsx:100` MobilePillComposer > the same disc sends when follow-ups steer: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canAbort` to `!(canAbort)`.
- `ui/MobilePillComposer.test.tsx:108` MobilePillComposer > a run with an empty input shows Stop in the disc: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canAbort` to `!(canAbort)`.
- `ui/MobilePillComposer.test.tsx:115` MobilePillComposer > uses the inline send action for content in a new-session draft: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canAbort && queuesFollowUp` to `!(canAbort && queuesFollowUp)`.
- `ui/MobilePillComposer.test.tsx:122` MobilePillComposer > shows neither send nor queue for an empty existing session: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canPrimaryAction` to `!(canPrimaryAction)`.
- `ui/MobilePillComposer.test.tsx:129` MobilePillComposer > shows neither send nor queue for an empty new-session draft: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canPrimaryAction` to `!(canPrimaryAction)`.
- `ui/MobilePillComposer.test.tsx:136` MobilePillComposer > keeps only abort while a session runs without content: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `canAbort` to `!(canAbort)`.
- `ui/MobilePillComposer.test.tsx:144` MobilePillComposer > renders the mic button when dictation is enabled and supported: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `showDictation` to `!(showDictation)`.
- `ui/MobilePillComposer.test.tsx:150` MobilePillComposer > hides the mic button when dictation is disabled: `ui/MobilePillComposer.tsx`. Kept unchanged; red after `showDictation` to `!(showDictation)`.

## ui/PromptHistorySearchPanel.test.tsx

- `ui/PromptHistorySearchPanel.test.tsx:101` PromptHistorySearchPanel > loads the newest matching prompt with Enter without submitting its containing form: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `event.preventDefault();` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:109` PromptHistorySearchPanel > focuses the seeded query with its text selected: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `inputRef.current?.select();` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:118` PromptHistorySearchPanel > filters full prompt text and picks the newest match: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.
- `ui/PromptHistorySearchPanel.test.tsx:125` PromptHistorySearchPanel > typing a query resets the selection to the newest match: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `setSelectedCandidate(null);` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:136` PromptHistorySearchPanel > bare arrows step older and newer without wrapping at either end: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.
- `ui/PromptHistorySearchPanel.test.tsx:151` PromptHistorySearchPanel > Ctrl and Cmd arrows step through history away from the endpoints: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `ui/PromptHistorySearchPanel.test.tsx:164` PromptHistorySearchPanel > Ctrl+P and Ctrl+N step older and newer: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `'older'` to `''`.
- `ui/PromptHistorySearchPanel.test.tsx:173` PromptHistorySearchPanel > modified arrows and Home/End keep native behavior and do not move the highlight: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` \|\| ` to ` && `.
- `ui/PromptHistorySearchPanel.test.tsx:188` PromptHistorySearchPanel > modified arrows and Home/End bubble past the panel so outer bindings can handle them: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` \|\| ` to ` && `.
- `ui/PromptHistorySearchPanel.test.tsx:204` PromptHistorySearchPanel > the selected row carries the selected-style hook after keyboard navigation: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `'older'` to `''`.
- `ui/PromptHistorySearchPanel.test.tsx:216` PromptHistorySearchPanel > pointer presses inside the panel keep input focus, while buttons keep native focus: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `ui/PromptHistorySearchPanel.test.tsx:235` PromptHistorySearchPanel > Ctrl+J and Ctrl+K are not cmdk vim bindings while editing the query: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `null` to `[]`.
- `ui/PromptHistorySearchPanel.test.tsx:244` PromptHistorySearchPanel > repeated open requests step older from the current selection: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.
- `ui/PromptHistorySearchPanel.test.tsx:252` PromptHistorySearchPanel > restarts at the newest match when the history is replaced: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` && ` to ` \|\| `.
- `ui/PromptHistorySearchPanel.test.tsx:264` PromptHistorySearchPanel > selects the newest result when empty history becomes populated: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` === ` to ` !== `.
- `ui/PromptHistorySearchPanel.test.tsx:270` PromptHistorySearchPanel > blocks form submission when Enter has no result and ignores IME composition: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `event.preventDefault();` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:279` PromptHistorySearchPanel > IME composition keeps Enter and arrows from picking or moving while a match is active: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after ` === ` to ` !== `.
- `ui/PromptHistorySearchPanel.test.tsx:289` PromptHistorySearchPanel > shows the empty state when there is no history: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.
- `ui/PromptHistorySearchPanel.test.tsx:295` PromptHistorySearchPanel > shows the no-match state, not the empty state, when the query matches nothing: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.
- `ui/PromptHistorySearchPanel.test.tsx:302` PromptHistorySearchPanel > a seeded query with several matches still starts on the newest match: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `activeCandidate` to `!(activeCandidate)`.
- `ui/PromptHistorySearchPanel.test.tsx:310` PromptHistorySearchPanel > the close button uses its native activation and does not pick the highlighted row: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `onClick={() => onClose('dismiss')}` to `onClick={undefined}`.
- `ui/PromptHistorySearchPanel.test.tsx:319` PromptHistorySearchPanel > Escape closes with dismiss: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `onClose('dismiss');` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:326` PromptHistorySearchPanel > focus leaving the panel closes it with blur: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `onClose('blur');` to `;`.
- `ui/PromptHistorySearchPanel.test.tsx:335` PromptHistorySearchPanel > clicking a row picks that prompt: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `onClick={() => onPick(candidate)}` to `onClick={undefined}`.
- `ui/PromptHistorySearchPanel.test.tsx:343` PromptHistorySearchPanel > aria-activedescendant names the highlighted row after keyboard navigation: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `activeCandidate` to `!(activeCandidate)`.
- `ui/PromptHistorySearchPanel.test.tsx:351` PromptHistorySearchPanel > keeps aria-activedescendant aligned with the newest filtered result: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `activeCandidate` to `!(activeCandidate)`.
- `ui/PromptHistorySearchPanel.test.tsx:360` PromptHistorySearchPanel > uses distinct input relationships for separate pinned composers: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `\`prompt-history-list-${panelId}\`` to `'prompt-history-list'`.
- `ui/PromptHistorySearchPanel.test.tsx:373` PromptHistorySearchPanel > caps the whole panel with a 300px anchor clearance: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `12` to `11`.
- `ui/PromptHistorySearchPanel.test.tsx:373` PromptHistorySearchPanel > caps the whole panel with a 140px anchor clearance: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `12` to `11`.
- `ui/PromptHistorySearchPanel.test.tsx:373` PromptHistorySearchPanel > caps the whole panel with a 80px anchor clearance: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `12` to `11`.
- `ui/PromptHistorySearchPanel.test.tsx:373` PromptHistorySearchPanel > caps the whole panel with a 0px anchor clearance: `ui/PromptHistorySearchPanel.tsx`. Kept unchanged; red after `0` to `1`.

## ui/__tests__/ComposerFloatingPanel.test.tsx

- `ui/__tests__/ComposerFloatingPanel.test.tsx:73` composer floating panel > a panel that mounts holding the room keeps the room the panel before it held: `state/composerInsetReaders.ts`. Kept unchanged; red after `px === null` to `!(px === null)`.
- `ui/__tests__/ComposerFloatingPanel.test.tsx:79` composer floating panel > a panel that does not hold the room takes its own height: `ui/ComposerFloatingPanel.tsx`. Kept unchanged; red after `!panel \|\| !column` to `!(!panel \|\| !column)`.

## ui/__tests__/usePlaceholderFitsOneLine.test.tsx

- `ui/__tests__/usePlaceholderFitsOneLine.test.tsx:65` usePlaceholderFitsOneLine > keeps the full text when the editor is wide enough for it: `ui/usePlaceholderFitsOneLine.ts`. Kept unchanged; red after ` \|\| ` to ` && `.
- `ui/__tests__/usePlaceholderFitsOneLine.test.tsx:69` usePlaceholderFitsOneLine > reports a miss when the full text would wrap: `ui/usePlaceholderFitsOneLine.ts`. Kept unchanged; red after `false` to `true`.
- `ui/__tests__/usePlaceholderFitsOneLine.test.tsx:73` usePlaceholderFitsOneLine > follows a change of text at the same width: `ui/usePlaceholderFitsOneLine.ts`. Kept unchanged; red after `false` to `true`.
- `ui/__tests__/usePlaceholderFitsOneLine.test.tsx:78` usePlaceholderFitsOneLine > keeps the full text while the editor has no width: `ui/usePlaceholderFitsOneLine.ts`. Kept unchanged; red after `true` to `false`.
