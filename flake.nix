{
  description = "OpenChamber — web UI for OpenCode sessions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # OpenCode CLI, pinned to the tag matching OpenChamber's OpenCode 2.x
    # requirement. Keep in sync with packages/electron/package.json
    # (opencodeCli.version) and the @opencode/client pin. Bump all together.
    opencode.url = "github:anomalyco/opencode/v2.1.3";
  };

  outputs =
    {
      self,
      nixpkgs,
      opencode,
    }:
    let
      systems = [
        # aarch64-linux is dropped until its dependency hash is verified on
        # that hardware; re-add it with a baked hash from an aarch64 build.
        "x86_64-linux"
      ];
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      opencodeCliVersion =
        (builtins.fromJSON (builtins.readFile ./packages/electron/package.json)).opencodeCli.version;
      opencodeTag =
        ((builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.opencode).original.ref or "no-tag";
    in
    {
      overlays.default = final: _prev: {
        openchamber = self.packages.${final.system}.openchamber;
      };

      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # The desktop's Electron: the major is read from packages/electron
          # devDependencies ("electron": "^44.9.0") at eval time, the same
          # file that pins the bundled CLI, so an upstream bump fails
          # evaluation with the next step named instead of reaching the
          # runtime as a startup crash (2.4.0 shipped while the flake still
          # built electron_43, and every desktop launch died on "setZoomMode
          # is not a function"). Only the major is asserted: nixpkgs' minor
          # is allowed to trail the caret range, the 44.x headers still carry
          # every 44.0 API the app's code uses, and they drive the node-pty
          # rebuild either way.
          electronSpec =
            (builtins.fromJSON (builtins.readFile ./packages/electron/package.json)).devDependencies.electron;
          electronMajor = nixpkgs.lib.versions.major (nixpkgs.lib.removePrefix "^" electronSpec);
          electron =
            pkgs.${"electron_${electronMajor}"}
              or (throw "packages/electron pins electron ${electronSpec}, but nixpkgs has no electron_${electronMajor}. Pin an older electron in packages/electron or wait for nixpkgs-unstable to carry the major.");
          # OpenCode CLI built from upstream's own nix recipe at the pinned
          # tag. Three tag quirks handled here: upstream's nix/hashes.json
          # predates the bun in our nixpkgs pin (pass the hash it actually
          # produces; other systems fall back to upstream's hashes.json),
          # their completion-generation postInstall fails with this tag's
          # compiled binary — the AppImage ships no completions either, so
          # drop it — and at 2.0.28 the CLI's build script imports
          # NativeArch from the monorepo root, which their src filter
          # doesn't ship (copy the root script/ dir in before the build).
          opencode-cli =
            # The opencode input's locked tag must be "v" + the CLI version
            # packages/electron pins, so drift fails nix-eval before merge.
            # Scoped to this binding so apps.update-hashes, which repairs the
            # drift, stays evaluable while the pair is out of sync.
            nixpkgs.lib.throwIf (opencodeTag != "v${opencodeCliVersion}")
              "flake pins opencode ${opencodeTag}, but packages/electron pins opencode CLI ${opencodeCliVersion}; the pair must match. Re-bake with: nix run .#update-hashes"
              (
                (pkgs.callPackage "${opencode}/nix/opencode.nix" {
                  node_modules = pkgs.callPackage "${opencode}/nix/node_modules.nix" {
                    # Their recipe derives the version suffix from the flake rev.
                    rev = opencode.rev or "dirty";
                    hash =
                      if pkgs.stdenv.hostPlatform.isx86_64 then
                        (builtins.fromJSON (builtins.readFile ./nix/hashes.json)).opencodeNodeModules
                      else
                        (builtins.fromJSON (builtins.readFile "${opencode}/nix/hashes.json")).nodeModules.${system};
                  };
                }).overrideAttrs
                  (old: {
                    # 2.0.28: build.ts imports NativeArch from the monorepo root,
                    # which their src fileset omits. Upstream fix:
                    # anomalyco/opencode#55494 — droppable once a tag ships it.
                    preBuild = "cp -R ${opencode}/script ./script";
                    postInstall = "";
                    # A Nix-built binary cannot self-update; disable upstream's
                    # auto-updater so it never fights the read-only store.
                    # Upstream fix: anomalyco/opencode#54641 — droppable once a
                    # tag ships it.
                    postFixup = ''
                      wrapProgram "$out/bin/opencode" --set OPENCODE_DISABLE_AUTOUPDATE 1
                    '';
                  })
              );
        in
        (rec {
          openchamber = pkgs.callPackage ./nix/package.nix {
            inherit self version;
            opencodeCli = opencode-cli;
          };
          openchamber-desktop = pkgs.callPackage ./nix/gui.nix {
            inherit self version;
            opencodeCli = opencode-cli;
            src = openchamber.passthru.src;
            openchamberCore = openchamber.passthru.core;
            inherit electron;
          };
          gui = openchamber-desktop;
          default = openchamber;
        })
        // {
          # The pinned OpenCode CLI that OpenChamber bundles, exposed on its
          # own so hosts can use the same 2.x build as the system opencode.
          opencode-cli = opencode-cli;
        }
      );

      apps = nixpkgs.lib.genAttrs systems (system: rec {
        openchamber = {
          type = "app";
          program = "${self.packages.${system}.openchamber}/bin/openchamber";
        };
        gui = {
          type = "app";
          program = "${self.packages.${system}.openchamber-desktop}/bin/openchamber-desktop";
        };
        update-hashes = {
          type = "app";
          program =
            toString (
              nixpkgs.legacyPackages.${system}.writeShellScriptBin "update-hashes" (
                builtins.readFile (self + "/nix/update-hashes.sh")
              )
            )
            + "/bin/update-hashes";
        };
        default = openchamber;
      });

      formatter = nixpkgs.lib.genAttrs systems (
        system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style
      );

      devShells = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nodejs
              git
              python3
              nixfmt-rfc-style
            ];
          };
        }
      );

      nixosModules = {
        openchamber = import ./nix/module.nix self;
        default = self.nixosModules.openchamber;
      };
    };
}
