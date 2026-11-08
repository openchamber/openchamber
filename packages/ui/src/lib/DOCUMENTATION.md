# Hosted surface selection

## Ownership

`runtimeSurface.ts` owns the choice between the mobile and desktop app shells in a hosted browser. It stamps the answer on `window` at boot, and every `isMobileSurfaceRuntime()` caller reads that answer. Capacitor, Electron and VS Code have fixed surfaces and skip the heuristic. The live tablet layout inside the mobile shell belongs to `useTabletLayout` in `device.ts`.

## Invariants

- An explicit stamp or `?surface=` override wins over the heuristic, and an override stops the resize watcher.
- Rotating a phone never changes its surface, so it never reloads the document.
- Tablets and fine-pointer touch desktops follow the viewport width: a coarse-pointer tablet is mobile up to 768 CSS px wide, so rotating it can still reload into the other shell.

## Decisions

### Why a phone is recognized by the screen's short side and not by the viewport width

A rotated phone's viewport and `screen.width` both report the long side, so a width check flips during rotation and the resize watcher reloads into the desktop shell. The short side stays the same in both orientations.

### Why the short-side rule stops at 600 CSS px and not at 768

768 would move small tablets to the mobile shell in landscape, where they get the desktop shell today. 600 is the line `useTabletLayout` already uses for tablets, so one constant decides both.

### Why the short-side rule reads only `(pointer: coarse)` and not the wider touch check

`hover: none` and touch points also match touch laptops driven by a mouse. On those the short side would keep the mobile shell at full width, so they stay on the viewport width rule.
