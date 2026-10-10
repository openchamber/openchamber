{
  description = "OpenChamber — web UI for OpenCode sessions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # OpenCode CLI, pinned to the tag matching OpenChamber's OpenCode 2.x
    # requirement. Keep in sync with packages/electron/package.json
    # (opencodeCli.version) and the @opencode/client pin. Bump all together.
    opencode.url = "github:anomalyco/opencode/v2.0.25";
  };

  outputs =
    {
      self,
      nixpkgs,
      opencode,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      overlays.default = final: _prev: {
        openchamber = self.packages.${final.system}.openchamber;
      };

      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # OpenCode CLI built from upstream's own nix recipe at the pinned
          # tag. Two tag quirks handled here: upstream's nix/hashes.json
          # predates the bun in our nixpkgs pin (pass the hash it actually
          # produces; other systems fall back to upstream's hashes.json),
          # and their completion-generation postInstall fails with this
          # tag's compiled binary — the AppImage ships no completions
          # either, so drop it.
          opencode-cli =
            (pkgs.callPackage "${opencode}/nix/opencode.nix" {
              node_modules = pkgs.callPackage "${opencode}/nix/node_modules.nix" {
                # Their recipe derives the version suffix from the flake rev.
                rev = opencode.rev or "dirty";
                hash =
                  if pkgs.stdenv.hostPlatform.isx86_64 then
                    "sha256-jTkP2Y1E9CHl/HChpAmdTovdOTBEkotuY2B2GARDdEA="
                  else
                    (builtins.fromJSON (builtins.readFile "${opencode}/nix/hashes.json")).nodeModules.${system};
              };
            }).overrideAttrs
              (old: {
                postInstall = "";
                # A Nix-built binary cannot self-update; disable upstream's
                # auto-updater so it never fights the read-only store.
                postFixup = ''
                  wrapProgram "$out/bin/opencode" --set OPENCODE_DISABLE_AUTOUPDATE 1
                '';
              });
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
            # Same major as packages/electron devDependencies ("electron":
            # "^43.7.0"); bump both together, like nixpkgs' element-desktop does.
            electron = pkgs.electron_43;
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
                builtins.readFile ./nix/update-hashes.sh
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
