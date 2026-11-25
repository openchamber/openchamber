# Dictation controls

## Ownership

This module owns composer and plain-field dictation controls, composer overlay integration, and microphone-level rendering. `useDictation` owns the recording lifecycle; the host owns draft insertion, submission, and composer sizing.

## Invariants

- A plain field's recording lives in `FieldDictationHost` at the app root, never in the field: a panel tab, a project switch or a closed panel unmounts or hides the field. `lib/dictation/fieldDictation.ts` holds the recordings by field key. The transcript goes to the field captured at start, mounted or not; starting in another field finishes the running one into its own.
- Closing a field's panel finishes its recording, however the panel closes. A panel registers itself with `useFieldPanelOpen`; a tab switch inside it keeps the registration, so the recording goes on. The check runs after the commit, so a panel that re-registers in the same update has not closed.
- A failed field recording keeps its audio until the user retries or discards it. The notice has Retry and no other way out, because the field may be hidden or gone.
- A context panel in its own window holds its close until its recordings end, since closing the window ends the microphone and the audio with it.
- Only 1 composer per window owns microphone capture and its keyboard confirmation. Inline controls leave the global dictation shortcut to the composer, because another listener can start 2 recordings from 1 key press.
- `onStart` runs once when dictation leaves idle, before the delayed transcript arrives, so the host associates it with the draft visible at recording start. `onSendStart` runs at each **Insert and send** confirmation, so the host captures the target the user confirmed; it also lets the mobile host hold the composer open until asynchronous insertion or submission settles.
- Recording shows no live transcript because the server transcribes after recording stops. The overlay renders transcript text only for failed-dictation salvage.
- The overlay preserves the composer's geometry. Its action row uses the mounted ancestor footer's measured height, which includes controls taller than the dictation buttons. Text padding includes the textarea padding and the attachment row's 4px top padding; control spacing matches the composer.
- Salvage height belongs to the instance that reports it. Only that instance clears the report, because an idle mobile sibling can mount beside a failed dictation.
- All transcript, placeholder, and error content stays inside the measured content block. The host applies editor line and viewport caps before the salvage area scrolls.
- Rewraps preserve the reader's scroll position unless the reader follows the end. Initial end-following runs after the host's second layout commit applies its height cap, before paint, because the initial unbounded area has no overflow yet.
- Turning dictation off in Settings hides the controls only at idle. A recording in progress keeps its overlay and keys, because the microphone stays on until it ends.
- Dictation controls preserve soft-keyboard focus. Preventing mouse and touch focus transfer keeps taps on the microphone and overlay controls from dismissing the iOS keyboard.

## Decisions

### Why gate VS Code separately from capture support

Dictation needs the WebSocket and speech-to-text worker in the OpenChamber web server. The VS Code bridge has no server process for them, even when microphone capture is available.

### Why use the server's active model for download progress

The saved model can leave the catalog, so progress follows the server's `activeModel` with the saved model as fallback.

### Why notify overlay activity in a layout effect

The host's expand or collapse state lands in the same paint as the overlay. A passive effect exposes a clipped frame inside the collapsed composer before the morph starts.

### Why capture recording keys before the composer handles them

Capture-phase handling consumes confirmation and cancellation keys before the underlying composer's Enter-to-send handler can submit.

### Why measure salvage content instead of its flex container

The absolutely positioned overlay cannot grow the host itself. Reporting content height plus padding lets the host grow it; feeding back the flex container's `scrollHeight` tracks the host height and causes repeated pixel growth.

### Why split horizontal and vertical overflow classes

`mobile.css` rewrites the `overflow-hidden` shorthand to vertical auto overflow on touch devices. Explicit axis classes avoid a phantom Android scrollbar.

### Why keep a single overlay background and delay mobile content

Desktop keeps the overlay transparent inside the composer box while hiding the box's other contents; mobile hides the pill or box and puts the background on an inner overlay layer. The mobile background appears immediately during the morph, but content fades in after expansion so controls do not paint clipped inside the small pill.

### Why allow the transcript area to shrink to zero

A fixed minimum text-area height exceeds the mobile composer's available space and pushes the actions below its footer. `min-h-0` lets the text area fit the underlying composer.

### Why a failed field recording waits and does not deliver its partial text

Delivering the partial text and ending threw away the audio a retry needs, and a retry after it would write the same words twice. The partial text is one of the choices on failure.

### Why draw waveform samples through a canvas subscription

Microphone levels arrive about 12 times per second, so React state would rerender the whole overlay at that rate. A scrolling trace makes recording activity visible, with samples about 60ms apart for readable motion and a level curve that raises quiet speech.

### Why hold peaks between waveform samples

Each sample retains the highest intervening level so a short syllable between frames stays visible. Rounded strokes subtract 1 cap diameter from their drawn length so the caps fit the intended bar height.
