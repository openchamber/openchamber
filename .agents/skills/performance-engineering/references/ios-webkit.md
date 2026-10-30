# Performance on the iOS app (Capacitor WebKit)

For lag, stutter or a slow keyboard in the iOS app, and before writing motion,
focus handling or large always-mounted markup that runs there.

- *Measure on the phone*: the setup and `bun run profile:ios`.
- *Rules*: what WebKit on iOS does differently from Chrome, each with the cost
  it had and the test that guards it.
- *Finding an unknown cost*: the method that found the ones below.

## Measure on the phone

The simulator runs WebKit on the Mac's CPU and composites in its own way:
latency, frame rate and what reaches the compositor are true only on a device.
Use the simulator for layout and flows (`serve-sim`), the phone for timing.

1. Build a Debug app and install it. Capacitor makes the WKWebView inspectable
   only in Debug. From `packages/mobile`, with the phone on USB (its id from
   `xcrun devicectl list devices`):

   ```sh
   node scripts/with-mobile-env.mjs "bun run build" && npx cap copy ios
   cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -destination 'id=<udid>' -derivedDataPath /tmp/oc-device-dd -allowProvisioningUpdates build
   xcrun devicectl device install app --device <udid> /tmp/oc-device-dd/Build/Products/Debug-iphoneos/App.app
   xcrun devicectl device process launch --device <udid> com.openchamber.app
   ```

2. Start the inspector bridge and leave it running:
   `pymobiledevice3 webinspector cdp` (install with `pipx install pymobiledevice3`).
   It serves the app's page over CDP at `http://127.0.0.1:9222`.
   "Device is not connected" means the phone is off USB or not trusted.
3. Run `bun run profile:ios <command>` from the repository root. The commands
   and their options are in the header of `scripts/profile-ios.mjs`:
   - `keyboard`: tap to focus, tap to the keyboard's start, and main-thread
     blocks after focus;
   - `frames`: where the composer, its riders and the transcript stand on
     every frame of a keyboard open;
   - `dom-weight`: where a large subtree hides;
   - `eval` and `screenshot`.

   `--setup` and `--teardown` run code in the page around each tap, which is
   how you ablate a suspect.

What the bridge gives and what it does not:

- `Runtime.evaluate` answers plain values only; `awaitPromise` never returns.
  Leave async results on `window` and read them in a second call.
- Timeline records arrive with every timestamp 0 on current iOS, so time
  inside the page (`performance.now()`, a `MessageChannel` loop for main
  thread blocks) instead of with the timeline.
- `element.click()` on the composer pill opens the real keyboard, and the
  app's `oc:keyboard-anim` event marks its start.
- Every figure the page reports is the main thread's view. A jump that only
  the compositor draws (an animation's last frame, a layer swap) shows in a
  screen recording from Control Center and in no DOM number. When `frames`
  shows nothing moving and the person still sees a jump, ask for a
  recording.

To learn the shape of a native motion such as the keyboard, record it with
`xcrun simctl io booted recordVideo` and trace the edge frame by frame: shape
comes out right on the simulator, timing does not.

## Rules

Each rule below was broken once at a visible cost. `packages/ui/src/lib/iosWebKitMotion.test.ts`
and `lib/fileTypeIcons.test.ts` fail when one breaks again.

**Focus walks the rendered DOM.** On every text-field focus iOS WebKit walks
the rendered tree (it looks for the previous and next field), so the keyboard
starts only after a walk over everything rendered. The file-type icon sprite
(2,086 symbols, 1,009 internal `<use>` elements, each a live shadow copy)
added about 150 ms to every tap until its `<svg>` went `display: none`. Its
gradients and clip paths moved to a small rendered `<svg>` beside it, because
a paint server inside an unrendered SVG paints nothing (`lib/fileTypeIcons.ts`).
Large markup kept in the document for reference (sprites, templates,
off-screen caches) stays out of rendering. `inert` does not take it out of
the walk; `display: none` does.

**`linear()` easings run on the main thread.** WebKit hands no animation with
a `linear()` easing to Core Animation (`KeyframeEffect::canBeAccelerated`). A
transform or opacity on one runs at 60 Hz beside a 120 Hz keyboard and
stalls with every task. Spring motion of composited properties runs as a Web
Animation on keyframes sampled from the curve, with `easing: 'linear'`
(`keyboardKeyframes` in `lib/mobileKeyboardTiming.ts`), which Core Animation
accepts. A `linear()` easing is fine where nothing is composited anyway: a
height, a width, a `bottom`, a clip. A CSS transition cannot take keyframes,
so one that moves a composited property gets a cubic-bezier fitted to its
spring under `@supports (-webkit-touch-callout: none)`, which matches iOS and
iPadOS WebKit only (`.oc-popup-motion` in `styles/design-system.css`); Chromium
keeps the spring, which it composites.

**120 Hz needs an opt-in.** Without `CADisableMinimumFrameDurationOnPhone` in
the app's Info.plist, an iPhone caps the app's own animations at 60 Hz while
the keyboard runs at 120 Hz.

**scrollTop moves in whole pixels, from the main thread.** A scroll position
written every frame steps at 60 Hz at most and creeps its last pixels in
visible steps. Smooth programmatic scrolling sets scrollTop once and runs the
travel as a transform on the scroller's content
(`components/chat/lib/scroll/keyboardFollowGlide.ts`). The scroller itself is
never transformed: WebKit rebuilds its composited scrolling layers, a
multi-second stall on a long chat.

**A width animation re-lays out everything beside it on every frame.** The
iPad side panels animated their width, so the chat re-wrapped on each frame
and a 200 ms open drew three or four frames. A panel changes width once and
slides over the space as a transform (`useIpadPanelSlide` in
`apps/ipadSidebarResize.ts`); the chat re-wraps once, at the start of an
open and the end of a close.

**Inherited custom properties on the root restyle the page.** The general
rule is in `SKILL.md` (*Known Costs*); on iOS it cost 150 ms per keyboard
open and close and held the composer still while the keyboard rose, and
45 ms per iPad panel toggle. Keyboard geometry is written through
`lib/mobileKeyboardInsets.ts` only; the chat's insets for overlays live in a
store (`lib/mobileChatInsets.ts`).

**A surface starts moving before it does its work.** A drawer or sheet
that slides on a transform keeps sliding while the main thread is busy, but
it starts only after the commit that opens it. Work in that commit (waking a
list, mounting rows below the fold, a refresh) is time between the tap and
the first frame of motion. Open the surface first and run the rest a frame
after its transition starts: the sessions drawer wakes its list then
(`useActiveAfterSlideStarts` in `apps/MobileSessionsSheet.tsx`), and the
model panel mounts the expanded provider's rows then, but only when the rows
above already fill the panel, so it never grows mid-rise (`ModelControls`).
Each cut 25–35 ms from tap to motion. Measure tap to `transitionrun` with
`profile:ios eval`.

**What follows the keyboard changes its layout once and rides on a transform.**
A `bottom` or `height` that transitions with the keyboard re-lays the page
out on every frame, on the main thread, and climbs in 60 Hz steps beside the
120 Hz keyboard. The shell and every keyboard-inset surface (drawers,
dialogs, the comment bar, `.oc-keyboard-inset-surface` in `mobile.css`) take
the keyboard into their layout where the change is invisible
(`--oc-kb-layout` for the shell, `--oc-kb-surface` for the surfaces over it:
when it has landed, as it starts to fall); a keyboard opened for a field over
the shell leaves the shell and its transcript as they are. What sits at
their bottom carries `data-keyboard-rider` (a factor, `0.5` for a centred
card) and rides the keyboard meanwhile on keyframes, with the composer
(`slideMovers` in `apps/mobileNativeChrome.ts`). `MobileOverlayPanel` snaps
its anchor when the keyboard starts instead, because its sheet is capped by
the space above the keyboard, and slides the sheet itself. A new surface that
follows the keyboard marks its bottom content as a rider; the guard test fails
on a layout property transitioning with the keyboard.

**The keyboard is a spring.** A critically damped spring with a 0.255 s
response, settled in 375 ms (`lib/mobileKeyboardTiming.ts`). Motion that
follows the keyboard uses that curve and that duration; a cubic-bezier of the
same length visibly leads or trails it.

The composer's own keyboard rules (swap before focus, the caret hold, hide
from `focusout`) live in `packages/ui/src/components/chat/composer/DOCUMENTATION.md`.

## Finding an unknown cost

The tap delay above was found in four runs, none of which needed a guess:

1. `profile:ios keyboard` on a fresh launch and again with a long chat open
   showed a block after focus that only the long chat had.
2. The element count of the document against that of the transcript showed
   most elements living outside it. `dom-weight` pointed at one subtree.
3. `keyboard --setup "<hide it>" --teardown "<restore it>"` removed the
   block. An ablation that removes the block names the cause; one that does
   not clears the suspect.
4. The fix was checked the same way on a Debug build, then the icons were
   compared visually on the phone (`screenshot`) and in Chrome.
