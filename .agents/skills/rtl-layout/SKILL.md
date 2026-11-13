---
name: rtl-layout
description: Use when creating or modifying OpenChamber UI layout, horizontal positioning, offsets or scroll math, resize or drag handles, arrow-key navigation, directional icons, or slide animations.
---

# RTL Layout

Arabic and Hebrew mirror the whole interface. Components read direction as `useI18n().direction`, or as `isRightToLeft(el)` from `@/lib/i18n` in event handlers and code outside React. Do not call `el.matches(':dir(rtl)')`: it throws on WebKit before 16.4. Adding a right-to-left locale follows `locale-ui-patterns`.

Every layout change works in both directions.

## Logical by default

Write sides as start and end of the line: `ms-`/`me-`, `ps-`/`pe-`, `inset-s-`/`inset-e-`, `text-start`/`text-end`, `rounded-s`/`rounded-e`/`rounded-ss`, `border-s`/`border-e`; in CSS and inline styles `margin-inline-start`, `padding-inline-start`, `inset-inline-start`. Flex and grid already follow `dir`, so DOM order stays semantic.

What CSS cannot express flips with the `rtl:` variant: `translate-x-*` (`data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4`), `bg-gradient-to-r rtl:bg-gradient-to-l`, `origin-top-left rtl:origin-top-right`, and inline transforms built from a sign. A fade toward the end of a line uses `linear-gradient(var(--oc-to-inline-end), …)`.

## Physical on purpose

Some sides belong to the screen. The lint rule `openchamber/no-physical-sides` flags physical classes in `packages/ui` class lists, so a deliberate one carries `// oxlint-disable-next-line openchamber/no-physical-sides -- <why it is physical>`:

- **OS window controls.** macOS traffic lights stay top left in every language; frameless Windows/Linux controls stay on the side the user picked. The titlebar publishes `--oc-titlebar-start-inset` and maps controls through `getInlineStartSide(direction)` (see `Header.tsx`, `TitlebarLeftControls.tsx`).
- **Geometry from measurement.** An element moved by `offsetLeft`, `getBoundingClientRect().left` or `clientX` anchors with `left-0`, because the numbers are physical (the active-tab pill in `sortable-tabs-strip.tsx`).
- **Content that reads left to right:** code, diffs, terminal output and its key strip, file paths and path fields, URLs, IDs, charts along a time axis. The container gets `dir="ltr"`, so its own logical classes resolve as physical inside it.
- **Keyboard keys and labels** that name a physical key ("close tabs to the left" means the screen's left).

## Direction-aware behaviour

- **Resize and drag.** A handle on a panel's edge changes width by the pointer delta times a sign: `(clientX - startX) * (rtl ? -1 : 1)` for a start-side panel. Arrow keys on the handle take the same sign.
- **Horizontal scroll.** In RTL `scrollLeft` is 0 at the start and negative toward the end. Distance from the start is `Math.abs(scrollLeft)`; distance from the physical left is `scrollWidth - clientWidth + scrollLeft`. Wheel-to-horizontal mapping flips the delta.
- **Previous/next keys.** ArrowLeft and ArrowRight swap meaning when they step through a horizontal sequence (tabs, image viewer, thinking levels).
- **Sorting.** `horizontalListSortingStrategy` assumes later items sit further right; pass `rectSortingStrategy` in RTL (see `drag-to-reorder`).
- **Slide-ins.** A drawer, pushed page or row swipe moves toward the side its trigger sits on; compute the offset sign from `direction` and mirror edge swipes with it (`MobileApp.tsx`, `MobileSessionSwipe.tsx`).

## Mixed-direction text

User content (session titles, run names, file names in lists) gets `dir="auto"` so it shows its own start when truncated. Text whose direction differs from the UI aligns with the interface through `oc-ui-start-align`, so it lines up with the rows around it. Values made of numbers and units ("~41 tok/s", "6.6K ↑ · 242 ↓") also take `dir="auto"`. Markdown already resolves direction per block; see `components/chat/message/parts/DOCUMENTATION.md` before touching it.

## Icons

`DIRECTIONAL_ICONS` in `components/icon/Icon.tsx` lists the icons that mirror in RTL (back/forward, chevrons, panel sides, send); one CSS rule flips them through `:dir(rtl)`, so an icon inside a `dir="ltr"` block stays as drawn. A new icon whose meaning points somewhere joins the set. The flip happens before the `<svg>`'s own rotation, so a chevron that turns a quarter turn pairs it: `rotate-90 rtl:-rotate-90`.

## Verify

1. Take English screenshots of the affected screens before the change and after it; they match pixel for pixel.
2. Switch to Arabic (`localStorage['openchamber.i18n.v1'] = '{"locale":"ar"}'`) and check that the same screens mirror English, then drag, scroll and use the arrow keys on whatever changed: each moves toward the mirrored side.
3. For phone layouts, check the drawer and swipe direction at a 390px touch viewport.
