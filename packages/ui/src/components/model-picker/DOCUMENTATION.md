# Model picker list

## Ownership

`ModelPickerList` is the searchable model list every model picker draws: the
composer's model menu and its phone sheet, the multi-run model chooser and the
agent model selector in Settings. It owns the rows (Auto, the leading action, Favorites,
Recent, one section per provider), keyboard navigation from the search field,
the details card, starring, collapsing and reordering. Callers own the menu
around it, the footer's text and what a pick does.

## Invariants

- The list is one virtual list. Every row, section captions included, is an
  entry of `rows`; only rows near the view are mounted, whatever the number of
  providers or models.
- The highlight lives in `IndexSelectionStore`, outside React state: a key
  press re-renders the two rows whose highlight changed, never the list.
- Focus stays in the search field. The field names the highlighted row through
  `aria-activedescendant`, and points at nothing while that row is unmounted.
  Rows of one section sit in a `role="group"` named after it.
- Recent leaves out models Favorites already lists. Provider sections always
  list every model of the provider.
- At rest a row shows its logo where the section does not say the provider,
  its name, its context size and a set star. An empty star, the section
  chevron of an open section and the effort a row would run with appear on
  hover or highlight.
- Under a finger (`pointer: coarse`) rows are at least 44px tall and the key
  hints footer is gone. With `onEntryDetails`, a device without hover leaves
  the stars off the rows; a long press (or a right click) opens the details,
  where the star lives instead.
  Without hover, an empty star would otherwise remain visible at all times.
- `allowedProviderIds` distinguishes an omitted restriction from an empty
  allowlist. An empty allowlist exposes no providers, including in pickers
  restricted to authenticated providers. `isModelAllowed` adds capability
  restrictions on top of that allowlist.
- With `providersStartCollapsed`, search temporarily opens matching providers
  without changing stored collapse choices. Outside search, explicitly opened
  providers and the current model's provider start open unless explicitly closed.
- Metadata subscriptions cover both models.dev metadata and live provider
  records, because models missing from models.dev use the provider's record.
- The dragged row stays mounted across scrolling, and releasing a drag must
  not pick a model or toggle a section.
- Keyboard events from controls inside a row belong to those controls. The
  sticky fade allows keyboard-generated clicks, whose zero coordinates do not
  identify a pointer location.

## Decisions

### Why one virtual list and not a virtualizer per long section

Sections used to virtualize on their own past 40 models and render shorter
ones whole, so ten providers of 30 models mounted 300 rows on every open.
With captions as rows, one virtualizer covers the whole list. The sticky
caption is an overlay that names the section of the top row, because a
`position: sticky` caption cannot stick inside absolutely placed rows.

### Why the virtualizer's view is capped at the window

The menu's first layout comes before its positioner sets the room it has
(`--available-height`), so the scroller is briefly as tall as every row and
the virtualizer would mount all of them. Capping the observed height at the
window keeps that first frame to a screenful. The first render already holds
that screenful (`initialRect` at the window height): rows mounted one commit
after the popup read to the popup's height morph as a content change, and the
menu opened tall and eased down to its size. Opening a 471-model list went
from about 300 ms to about 60 ms in the dev build with this and the change
above.

### Why one details card and not a tooltip per row

A tooltip per row kept a tooltip root mounted for every row while at most one
card shows. `ModelPickerRowCard` follows the highlighted row and anchors to it
(`TooltipContent anchor`).

The card follows the highlighted row's current DOM element when virtualization
remounts it and closes when the row disappears. Its offset clears the list's
padding and leaves about 10px between the picker and the card. It only appears
when a side has room for its full width plus the offset, so it cannot cover the
list. A provider name alone warrants a card because it distinguishes same-named
models even when capability and cost data are absent.

### Why row heights are measured by kind and not by row

Rows of one kind share a font-dependent height, and measured heights persist
across opens so the list lays out correctly immediately. Measuring one mounted
row per kind avoids observers remeasuring the whole viewport on every frame of
the menu's opening animation, which costs more than virtualization saves.

### Why reveal requests follow selection and not every row change

Opening, changing the query, or changing the selected model requests a reveal
once its row exists, including when models load after opening. Starring and
collapsing only shift rows around the pointer and must not trigger another
scroll. A stationary pointer must not replace the current highlight when the
list opens or scrolls.

### Why row refs stay stable and detached refs wait until the commit ends

One callback per navigation index avoids detaching and reattaching every ref on
each render. Clearing `aria-activedescendant` after a detach waits until the
commit ends, so a row reattached in that commit does not cause duplicate screen
reader announcements.

### Why starring keeps focus in the search field

Unstarring can remove the focused row. The popup then moves focus to its last
button and scrolls to the bottom, so the star keeps focus in the search field
or returns it there. Star presses also stop propagation so they cannot start a
row drag.

### Why the scroller keeps its bottom fade

The fade indicates that the list continues under the key-hint footer. Without
it, the last visible row looks cut off.

### Why the whole row drags and not a grip

Grips on every favorite and provider caption were noise at rest. The row or
caption itself is the drag handle: a mouse drag starts after 8 px, so a click
still picks or folds, and a touch drag after a 250 ms press, so a swipe still
scrolls. dnd-kit's attributes are left off the row, because they would replace
its `option` role. While a provider is dragged every provider folds to its
caption, so the captions are what moves, and a copy of the dragged caption
follows the pointer from `document.body`: inside the menu's transformed popup
a fixed element lands off the pointer.

Sortable captions use a div with button semantics because attaching dnd-kit's
listeners to a button makes it a draggable widget. Plain captions remain buttons.

### Why the phone's sheet draws this list and not its own

The phone had a list of its own: a boxed card per section, two lines per
model with capability icons nobody could explain on touch, an effort chip and
a star on every row. Every change to the desktop list missed it. It now draws
this list with `onEntryDetails` and `providersStartCollapsed`: one line per
model, the effort only on the current one (a tap opens the effort sheet), and
the details in a sheet of their own.

### Why a long press swallows the next click

A finger lifting after a long press can still click where it lay. Over the
row that click picked the model; once the details sheet was open it landed on
the sheet's backdrop and closed it at once. The press listens for that one
click and swallows it.
