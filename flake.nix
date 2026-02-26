{
  description = "OpenChamber development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              # JS / TS
              bun
              nodejs_20

              # Rust toolchain (Tauri desktop builds)
              rustc
              cargo
              clippy
              rustfmt
              rust-analyzer

              # Tauri CLI
              cargo-tauri

              # Tools
              pkg-config
              openssl
              git
              python3
              gnumake
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [
              gcc
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
            ]
            ++ lib.optionals stdenv.hostPlatform.isDarwin (
              with darwin.apple_sdk.frameworks;
              [
                WebKit
                AppKit
                CoreServices
                Security
              ]
            );

          env = {
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
      });

      overlays = {
        default =
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev;
            };
            openchamber = final.callPackage ./nix/openchamber.nix {
              inherit node_modules;
            };
            desktop = final.callPackage ./nix/desktop.nix {
              inherit openchamber;
            };
          in
          {
            inherit openchamber;
            openchamber-desktop = desktop;
          };
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
          openchamber = pkgs.callPackage ./nix/openchamber.nix {
            inherit node_modules;
          };
          desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit openchamber;
          };
        in
        {
          default = openchamber;
          inherit openchamber desktop;
          # Updater derivation with fakeHash — build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );
    };
}
