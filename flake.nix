{
  description = "OpenChamber – web and desktop UI for OpenCode";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = "1.7.5";

        # Tauri v2 system dependencies (Linux only)
        tauriLinuxDeps = with pkgs; [
          pkg-config
          openssl
          webkitgtk_4_1
          libsoup_3
          glib
          gtk3
          cairo
          pango
          gdk-pixbuf
          librsvg
          libappindicator-gtk3
          dbus
        ];

        # macOS frameworks for Tauri
        tauriDarwinDeps = with pkgs.darwin.apple_sdk.frameworks; [
          WebKit
          AppKit
          CoreServices
          Security
        ];

        # Native node module build deps (node-pty, bun-pty)
        nativeBuildDeps =
          with pkgs;
          [
            python3
            gnumake
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [ gcc ];

        # -----------------------------------------------------------
        # Fixed-output derivation: fetch and build all node_modules
        # -----------------------------------------------------------
        bunDeps = pkgs.stdenv.mkDerivation {
          pname = "openchamber-deps";
          inherit version;
          src = self;

          impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars;

          nativeBuildInputs =
            with pkgs;
            [
              bun
              nodejs_22
              cacert
              git
              python3
              gnumake
              pkg-config
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [ gcc ];

          dontConfigure = true;
          dontFixup = true;

          buildPhase = ''
            export HOME=$TMPDIR
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt

            # Skip install scripts — bun's sandbox breaks node-gyp.
            # We handle native modules and patches manually below.
            bun install --frozen-lockfile --ignore-scripts

            # Re-apply patch-package (the monorepo postinstall hook)
            ${pkgs.nodejs_22}/bin/node node_modules/.bin/patch-package || true

            # Build node-pty from source with node-gyp
            export npm_config_nodedir=${pkgs.nodejs_22}
            export npm_config_python=${pkgs.python3}/bin/python3
            (cd node_modules/node-pty && ${pkgs.nodejs_22}/bin/node ../../node_modules/.bin/node-gyp rebuild) || true

            # Remove workspace symlinks — they point to ../../packages/*
            # which won't exist in the nix store output.
            find node_modules -type l | while IFS= read -r link; do
              target=$(readlink "$link")
              case "$target" in
                ../../packages/*) rm "$link" ;;
              esac
            done
            find node_modules -type d -empty -delete 2>/dev/null || true
          '';

          installPhase = ''
            mkdir -p $out/root
            cp -r node_modules/. $out/root/

            # Also capture workspace-local node_modules (bun doesn't
            # always hoist workspace devDependencies to the root)
            for ws in packages/*/; do
              if [ -d "$ws/node_modules" ]; then
                wsname=$(basename "$ws")
                mkdir -p "$out/workspaces/$wsname"
                cp -r "$ws/node_modules/." "$out/workspaces/$wsname/"
              fi
            done
          '';

          # To compute: run `nix build .#openchamber` with lib.fakeHash,
          # then replace with the hash from the error message.
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-znnQNCIXrrFjPacIfA0PWoOWCcOrJ/6xIeabj0B7lpw=";
        };
      in
      {
        # -------------------------------------------------------
        # packages.default — installable openchamber CLI
        # -------------------------------------------------------
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "openchamber";
          inherit version;
          src = self;

          nativeBuildInputs = with pkgs; [
            bun
            nodejs_22
            makeWrapper
          ];

          dontConfigure = true;

          buildPhase = ''
            export HOME=$TMPDIR

            # Root third-party deps from the FOD
            cp -r ${bunDeps}/root node_modules
            chmod -R u+w node_modules

            # Restore workspace-local node_modules (non-hoisted deps)
            for ws in ${bunDeps}/workspaces/*/; do
              wsname=$(basename "$ws")
              if [ -d "packages/$wsname" ]; then
                cp -r "$ws" "packages/$wsname/node_modules"
                chmod -R u+w "packages/$wsname/node_modules"
              fi
            done

            # Fix #!/usr/bin/env shebangs for nix sandbox
            patchShebangs node_modules
            for ws in packages/*/node_modules; do
              [ -d "$ws" ] && patchShebangs "$ws"
            done

            # Recreate workspace symlinks so vite can resolve @openchamber/*
            mkdir -p node_modules/@openchamber
            ln -s ../../packages/ui    node_modules/@openchamber/ui
            ln -s ../../packages/web   node_modules/@openchamber/web

            # Build the web frontend with vite
            (cd packages/web && node ../../node_modules/vite/bin/vite.js build)
          '';

          installPhase = ''
            mkdir -p $out/lib/openchamber $out/bin

            # Files matching packages/web "files" field
            cp -r packages/web/dist    $out/lib/openchamber/dist
            cp -r packages/web/server  $out/lib/openchamber/server
            cp -r packages/web/bin     $out/lib/openchamber/bin
            cp -r packages/web/public  $out/lib/openchamber/public  2>/dev/null || true
            cp    packages/web/package.json $out/lib/openchamber/package.json

            # Runtime third-party node_modules
            cp -r ${bunDeps}/root $out/lib/openchamber/node_modules
            chmod -R u+w $out/lib/openchamber/node_modules

            # Merge workspace-local deps that bun didn't hoist to root
            # (e.g. web-push lives in packages/web/node_modules/)
            if [ -d "${bunDeps}/workspaces/web" ]; then
              cp -rn ${bunDeps}/workspaces/web/. $out/lib/openchamber/node_modules/ 2>/dev/null || true
            fi

            # Wrapper: run with bun (the project runtime)
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/openchamber \
              --add-flags "$out/lib/openchamber/bin/cli.js"
          '';

          meta = with pkgs.lib; {
            description = "Web and desktop UI for the OpenCode AI coding agent";
            homepage = "https://github.com/btriapitsyn/openchamber";
            license = licenses.mit;
            mainProgram = "openchamber";
          };
        };

        # -------------------------------------------------------
        # devShells.default — full dev environment
        # -------------------------------------------------------
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              # JS / TS
              bun
              nodejs_22

              # Rust toolchain (Tauri desktop builds)
              rustc
              cargo
              clippy
              rustfmt
              rust-analyzer

              # Tauri CLI
              cargo-tauri

              # Tools
              git
            ]
            ++ nativeBuildDeps
            ++ lib.optionals stdenv.hostPlatform.isLinux tauriLinuxDeps
            ++ lib.optionals stdenv.hostPlatform.isDarwin tauriDarwinDeps;

          env = {
            # Rust source path for rust-analyzer
            RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          };

          shellHook =
            ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "openchamber dev shell ready  —  bun $(bun --version), node $(node --version)"
            ''
            + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export GIO_MODULE_PATH="${pkgs.glib-networking}/lib/gio/modules"
            '';
        };
      }
    );
}
