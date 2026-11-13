{
  lib,
  runCommand,
  bun2nix,
}:
src:
let
  bunNix = runCommand "bun-dependencies.nix" { nativeBuildInputs = [ bun2nix ]; } ''
    bun2nix -l ${src}/bun.lock -c ${src}/ -o "$out"
  '';
in
bun2nix.fetchBunDeps {
  inherit bunNix;
  overrides = bun2nix.patchedDependenciesToOverrides {
    patchedDependencies = lib.mapAttrs (_: path: src + "/${path}") (
      (builtins.fromJSON (builtins.readFile (src + /package.json))).patchedDependencies or { }
    );
  };
}
