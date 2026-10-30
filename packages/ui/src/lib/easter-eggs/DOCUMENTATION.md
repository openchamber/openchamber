# Easter eggs

## Ownership

This module owns the small jokes the app tells at ordinary moments: the rotating new-session heading, the line under "Working tree clean", the toast for a late-night or Friday-evening push, the toast for a commit that deletes clearly more than it adds, and the calendar that switches some of them on Halloween and New Year. It picks lines; the components that show them (`components/chat/useDraftHeading.ts`, `GitEmptyState`, `GitView`) decide where. The celebration overlay lives in `components/ui/FireworksAnimation.tsx`, `fireworksShows.ts` and `holidayOrnaments.tsx`; it asks the calendar's `celebrationOf` which holiday or season a push or merge falls on. The About dialog's seven-tap logo animation is `components/ui/LevitatingLogo.tsx`.

## Invariants

- Every line lives in `copy/<locale>.ts`, one file per UI locale, typed by `copy/types.ts`. `lines.test.ts` fails when a locale is missing or a line lost the placeholder the code fills (`{project}`, `{time}`, `{count}`).
- A caller falls back to its ordinary translated text while the locale's copy loads and wherever a picker returns null. No one sees another language's joke, and nothing waits on this module.
- The clock is the viewer's local clock, read at the moment the line is picked.
- A line stays put while it is on screen: a draft keeps its heading while open, the clean state keeps its line while shown.
- A celebration runs from the day before its holiday to the day after (Hanukkah: its eight days plus one either side). The jokes' `occasionOf` stays on the exact day.
- A national day shows only where the viewer's time zone puts them in that country: Ukraine's Independence Day in Ukraine, July 4th and Thanksgiving in the US. Every other holiday shows everywhere.
- Seasons start on the 1st of March, June, September and December; a southern-hemisphere time zone gets the opposite season.
- A moving holiday (Lunar New Year, Eid al-Fitr, Hanukkah) is read from the engine's own calendar through `Intl`. An engine without that calendar shows no holiday rather than one on the wrong day. Engines can disagree by a day (Chromium puts Lunar New Year 2027 on February 7th, WebKit on the 6th); the day either side keeps the holiday itself inside the window.
- Zone tables list both the current and the old zone names: Chromium reports `America/Indianapolis` and `America/Cordoba` where WebKit reports `America/Indiana/Indianapolis` and `America/Argentina/Cordoba`.
- Enterprise mode shows all of this. The jokes are part of the product, not a consumer extra.

## Decisions

### Why separate copy files and not the i18n dictionaries

The dictionaries need the same keys in every locale, and the jokes do not translate one to one: a locale writes its own lines, may have more or fewer of them, and may skip one that does not work in that language (`push.fridayEvening` is empty in Arabic and Hebrew, where Friday evening already is the weekend). Lists of different lengths per locale do not fit flat keys, and one file per locale keeps every joke of a language in one place to read and edit.

### Why a net-deletion threshold

A commit that removes one line more than it adds is every other commit. The line shows from `NET_DELETION_THRESHOLD` lines net, so it stays a surprise.

### Why the draft heading is picked per draft id

The welcome heading and the composer heading render the same draft in two components. Keying the pick on the draft id makes both show the same line, keeps it while the draft is open, and moves to the next line with the next draft. A random seed per app run keeps the first draft after launch from always opening on the same line.

### Why drawn holiday ornaments keep their own colours and not theme tokens

Confetti, the New Year salute and Halloween candy take theme colours, because they are colour and nothing else. The holiday ornaments are drawings of real things: a flag, a tree, a cocktail. A theme whose `--status-info` is purple would fly a purple and yellow Ukrainian flag, so each ornament carries its own colours and looks the same in every theme. The only theme colour in them is the gap between clover leaves, which is the background.

### Why the time zone decides the country and the hemisphere

The time zone is the one location hint the app already has on every runtime, without a permission prompt or a network call. It is wrong for someone travelling or on a zone set by hand, and for those the cost is one wrong burst of confetti. A table of zones covers only the countries and hemisphere that need it. A zone missing from the southern table counts as northern; that is right for most of the world and costs a southern viewer one burst of the wrong season.
