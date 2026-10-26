# Brand assets

## Ownership

`scripts/brand` owns every drawing of the OpenChamber logo. `geometry.mjs` describes the shapes; `raster.mjs` turns them into PNG, the pixel-exact small cube and `.ico` files; `generate.mjs` writes each file where its runtime reads it. `bun run brand:generate` rewrites all of them; `bun run brand:generate --check` fails when a generated text file was edited by hand.

The logo has four drawings, each for a kind of place:

| Drawing | Where it shows |
|---|---|
| App icon, an Icon Composer document (`packages/electron/resources/icons/AppIcon.icon`) | macOS Dock and Finder, the iOS app. Its layers carry the six macOS appearances: Default, Dark, Clear and Tinted, light and dark |
| Icon without a tile: the open shell with a dark grey inside, white edges, black outline | Windows, Linux, the VS Code Marketplace; on a black square for phone home screens, PWA and Android |
| In-app logo: the open shell in one colour | Every splash, About, sign-in, empty states, README |
| Glyph: cube outline and two roof rings, one colour | macOS menu bar, favicon, VS Code activity bar and title buttons, model picker sprite, Android notification and themed icon, iOS Control Center |

The macOS menu bar animation lives in `packages/electron/tray.mjs`; this module only draws its frames. `OpenChamberLogo.tsx` renders the in-app logo from the generated `openChamberLogoArt.ts` and owns its loading animation.

## Invariants

- Every logo file in the repository comes out of `generate.mjs`. A change to the logo is a change to `geometry.mjs` and a run of `bun run brand:generate`, never an edit of an output. One exception: the iOS widgets draw the in-app logo in SwiftUI (`CubeLogoView` in `packages/mobile/ios/App/OpenChamberWidget/WidgetShared.swift`), by hand from the same numbers. A change to the in-app logo updates it in the same change; `--check` does not cover it.
- The four HTML documents that show before React (the web `index.html`, the Electron splash in `early-startup.mjs`, the VS Code loader in `webviewHtml.ts`, the headless server page in `static-routes-runtime.js`) and `OpenChamberLogo.tsx` draw the same in-app logo. The HTML documents carry it between `<!-- brand:flat-logo:start -->` and `<!-- brand:flat-logo:end -->`; the generator rewrites only that region.
- The in-app logo is drawn in `currentColor` (or the splash stroke colour), never a fixed colour, so it follows every theme.
- Text outputs are checked by `generate.test.mjs`; image bytes are not, because they depend on the libvips build.
- On macOS with Xcode 26 the generator also compiles `Assets.car` and `icon.icns` with `actool`, renders `dev-icon.png` with Icon Composer's `ictool`, and writes the Control Center SF Symbol with `swiftdraw`. Elsewhere those files stay as they are.

## Decisions

### Why one script and not exported files

The logo used to live in about forty hand-exported files and six inline drawings that had to be kept in step by hand. A redesign touched all of them. With the shapes in code, the next change is one edit and one run, and a test catches a file edited on its own.

### Why the app icon is layered and not one picture

macOS turns a single flat picture into a grey smudge in Clear and Tinted: it can only reduce it to its brightness. Separate layers (shell, three tiers) let the system draw each as its own glass. The tiers appear twice: white with baked opacity for the light Default, opaque and coloured for Dark, Clear and Tinted, so each tier keeps its own tone there. A layer hidden in an appearance keeps glass off in it, or its glass still shows.

### Why the small Windows sizes are pixel art and not scaled vector

At 16 to 24 px the 30 degree edges fall between pixels and the cube blurs. `pixelCube` redraws it with 2:1 edges on whole pixels, no anti-aliasing, and a 1 px black outline for light taskbars. The `.ico` carries these for 16, 20 and 24 px and the vector rendering above that.

### Why the macOS dev icon is rendered by ictool and not drawn

The release Dock icon is glass rendered by the system. A flat drawing next to it looked like a different app. `ictool` renders the real document the way the Dock does, and the tape goes on top.
