# Desktop build and release scripts

## Ownership

These scripts own desktop asset staging, Electron bundling and native-module repair, package validation, update manifests, and signing handoffs. Native runtime behavior belongs to [the desktop shell](../DOCUMENTATION.md). Build commands and release procedures live in [README.md](../README.md).

## Invariants

- Packaging requires both each unpacked Git helper bootstrap and its sibling
  runtime. The helpers are launched from their physical unpacked paths.

- Development preloads the web package's `register-server-sources.mjs` before
  the launcher and Electron entry load. It resolves converted source modules
  behind `.js` specifiers; packaged builds continue to read emitted JavaScript.

- The web package contributes `build/server` and `build/bin` to the archive.
  Its original source trees stay out. Server source maps remain packaged while
  maps from other dependencies are stripped.

- Packaging rebuilds the SDK before the web server is bundled because the server imports its built exports. Asset-copy failure removes partially staged output so a later package cannot consume it.
- `early-startup.mjs` remains a shared runtime import of both main bundles. Inlining it gives entry and main separate handoff slots. The web server and native dependencies remain external: inlining the server can promote bun-pty's guarded dynamic import into a load-time `bun:ffi` import that Node cannot resolve.
- Canary and Stable keep the same app identity, installation, profile, and protocol handler so updates replace each other. Channel-specific icon paths remain complete when the release configuration gains another icon.
- macOS executable UUIDs derive from appId and remain stable across versions so Local Network consent survives updates. Rewriting the UUID precedes signing. ARM64 receives an ad-hoc signature after the rewrite so unsigned builds launch; x64 runs unsigned and its unsigned Electron framework prevents the same codesign operation.
- macOS icon assets for old and new OS versions come from the same icon document and the selected channel's directory.
- Package-content validation checks both accidental inclusions and missing runtime inputs. The UI ships once in Resources/web-dist; helper executables used by git and SSH exist outside ASAR, and the server's package manifest remains available for version reads. Target-specific ripgrep binaries ship in resources while build-host platform packages stay out of the archive.
- Electron repair validates executable architecture as well as version and presence. A same-version binary for another architecture still cannot launch. Repair removes partial extraction and stale path metadata before rerunning postinstall, preferring Bun extraction and retaining the Node fallback. Architecture selection follows Electron's Rosetta behavior.
- Native rebuilding uses the hoisted workspace node_modules and forces relinking against Electron. Prebuilt Node-API addons used by the separate speech worker receive architecture verification rather than an Electron rebuild.
- Bundled OpenCode is pinned by the exact `@opencode/server` development dependency, the package the bundle is built from, so the pin and the bundled code cannot disagree. Development explicitly passes the staged server directory because Electron's development resourcesPath points to Electron's own resources.
- Cross-built Windows ARM64 executables cannot run on x64 builders. The bundled OpenCode server's `--version` runs on Node there, which needs none of its native code, while header checks of every staged native file still prove the architecture because ARM64 Windows can also run an incorrect x64 binary. Ripgrep archives are verified against the lockfile's platform-specific sha512, including cached archives and architectures absent from the host installation.
- Archive extraction uses paths relative to the destination because GNU tar under Git Bash interprets an absolute Windows drive path as a remote host.
- A macOS update manifest contains both architectures. Otherwise electron-updater can choose Intel files for Apple Silicon through its x64 fallback. Minimum system versions use Darwin kernel versions because electron-updater compares with `os.release()`; Darwin 22 is the floor for Electron 45.
- Release finalization can reconstruct Windows manifests from uploaded installers when earlier manifest artifacts are unavailable. Draft release assets are addressed by release id. Manifest hashes and blockmaps describe the final signed bytes, and Linux feeds contain each supported installer format for their architecture.
- SignPath signs only app-owned executables. The two signing requests bracket the app build and installer build; upstream binaries keep their upstream signatures. The second pass reuses the unpacked app because the signed executable contains its ASAR hash. The sign hook swaps the uninstaller at the point between NSIS generation and embedding.

## Decisions

### Why executable headers and not installation metadata alone

Version files and path metadata can survive a partial or wrong-architecture Electron installation. Reading Mach-O, ELF, and PE headers verifies the binary that actually launches, including Rosetta and cross-build cases.

### Why archive validation and not packaging patterns alone

Electron Builder configuration changes can duplicate UI output or exclude a required runtime file. Checking the resulting ASAR header proves the package contains the intended runtime inputs independently of the pattern configuration.

### Why server staging resolves packages from their parent

Bun's isolated store places a package's dependencies beside it in the same `node_modules`. Walking upward from the importing package and resolving its real directory finds those dependencies as well as hoisted workspace packages.

### Why server assets come from target packages

The registry supplies the target platform's native packages because the host installation can contain a different architecture. The staging rules and loader rewrites follow OpenCode's Node build; the [bundled server documentation](../../web/opencode-server/DOCUMENTATION.md) owns their runtime contract. Node-pty ships as a whole package because its JavaScript entry loads a binding from `prebuilds`. Windows `.pdb` debug symbols are excluded because runtime loading does not use them. On macOS its `spawn-helper` starts shells and needs its executable mode restored after npm tarball extraction.

### Why the Claude Agent SDK is fetched separately

OpenCode's Claude Agent provider imports the optional peer version named by `@opencode/core`. Its JavaScript is bundled from the registry because installing it as a dependency would also fetch a 240 MB Claude Code platform binary. The provider starts the user's own `claude`, so that binary is unused.

### Why Linux version verification runs on Node

The staged server answers `--version` without loading native code, so Node can verify any target architecture. The packaged executable is used on macOS and Windows when the host can run it. Linux verification uses Node because the app executable loads GTK before reading `ELECTRON_RUN_AS_NODE`, and CI runners may lack GTK. Native-file header checks still verify the target architecture independently of the version probe.
