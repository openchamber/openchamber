# SPDX-License-Identifier: MIT OR Apache-2.0
#
# openchamber module — shared options and the start wrapper.
#
# Canonical home: developing-today-forks/openchamber, nix/modules
# (openchamber#1440 — the top layer of the cascade Drew specified
# 2026-11-03: each level offers an option that handles its service
# creation as a single enable switch). Imported by every platform
# module in this directory (nixos.nix, home-manager.nix,
# darwin.nix): the option set is the contract —
# `services.openchamber.enable`, `package`, `hostname`, `port`,
# `environment`, `uiPasswordFile`, and the `opencode` attach
# group — identical on every platform; only the service
# definition differs.
#
# The one-process rule is the default behavior, not an option a
# consumer must remember: OpenChamber ATTACHES to the standing
# opencode server (the fork's `serve --service`, managed by
# services.opencode below) and never starts its own. The start
# wrapper below is the durable form of the hand-maintained
# openchamber-start.sh + drop-in arrangement (openchamber#766):
# it reads the standing server's registration file at start,
# exports OPENCODE_PASSWORD from it (never through the store),
# points OPENCODE_HOST at the address the services.opencode
# options declare — one source of truth for the address, shared
# by both services — sets OPENCODE_SKIP_START=true, and refuses
# to start (exit 1, the manager's restart policy retries) when
# the registration is missing or carries no password: an
# OpenChamber running against the wrong server, or spawning its
# own, is worse than one that has not started yet.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.openchamber;
  oc = config.services.opencode;
in
{
  options.services.openchamber = {
    enable = lib.mkEnableOption "the OpenChamber server, attached to the standing OpenCode server";

    package = lib.mkOption {
      type = lib.types.package;
      description = ''
        The openchamber package to run. The flake's module outputs
        default this to the flake's own
        `packages.<system>.openchamber` build; override it to run
        another build.
      '';
    };

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Host the web server binds (`serve --host`). On systemd
        platforms this is also the socket unit's ListenStream
        address.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the web server listens on (`serve --port`).";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Extra environment variables for the server process. NOT
        for secrets: values are rendered into the generated
        unit/plist in the world-readable Nix store. The attach
        variables (OPENCODE_HOST, OPENCODE_SKIP_START,
        OPENCODE_PASSWORD, OPENCODE_BINARY) are set by the start
        wrapper at runtime and are not part of this option.
      '';
    };

    uiPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression ''"$HOME/.config/openchamber/ui-password"'';
      description = ''
        Path to a file holding the browser-UI password. When set
        and readable at start, the wrapper exports it as
        OPENCHAMBER_UI_PASSWORD; the file itself never enters the
        store.
      '';
    };

    opencode = {
      attach = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Attach to the standing opencode server instead of
          letting OpenChamber spawn and manage its own. This is
          Drew's one-process rule and the reason the cascade
          exists; turn it off only for a deployment that
          genuinely wants a second, managed opencode. When off,
          the wrapper sets none of the attach variables and does
          not require the registration file.
        '';
      };

      stateFile = lib.mkOption {
        type = lib.types.str;
        default = "$HOME/.local/state/opencode/service-prod.json";
        description = ''
          The standing server's registration file (written by the
          fork's ServiceRegistration on listen: id, url, pid,
          version, password). Read by the start wrapper at every
          start; only its `password` key is consumed. The default
          is the prod channel's path; the string is expanded by
          the wrapper's shell, so `$HOME` is literal here on
          purpose.
        '';
      };
    };
    startWrapper = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      internal = true;
      description = "The generated start wrapper (see the config block in common.nix).";
    };
  };

  config = lib.mkIf cfg.enable {
    # The cascade (Drew, 2026-11-03): this switch turns the whole
    # stack on. mkDefault everywhere: a consumer can still manage
    # or disable a lower layer themselves — what they never do is
    # wire the layers together by hand.
    services.opencode.enable = lib.mkDefault true;
    services.mcpx.enable = lib.mkDefault true;

    services.openchamber.startWrapper = pkgs.writeShellApplication {
      name = "openchamber-start";
      runtimeInputs = [
        pkgs.jq
        pkgs.coreutils
      ];
      text = ''
        ${lib.optionalString cfg.opencode.attach ''
          state_file="${cfg.opencode.stateFile}"
          if [ ! -r "$state_file" ]; then
            echo "openchamber: refusing to start — the standing OpenCode server's registration ($state_file) is not readable (openchamber#766)" >&2
            exit 1
          fi
          password="$(jq -r .password "$state_file")"
          if [ -z "$password" ] || [ "$password" = "null" ]; then
            echo "openchamber: refusing to start — $state_file carries no password" >&2
            exit 1
          fi
          export OPENCODE_PASSWORD="$password"
          export OPENCODE_HOST="http://${oc.hostname}:${toString oc.port}"
          export OPENCODE_SKIP_START=true
          export OPENCODE_BINARY="${oc.package}/bin/opencode"
        ''}
        ${lib.optionalString (cfg.uiPasswordFile != null) ''
          if [ -r "${cfg.uiPasswordFile}" ]; then
            OPENCHAMBER_UI_PASSWORD="$(cat "${cfg.uiPasswordFile}")"
            export OPENCHAMBER_UI_PASSWORD
          fi
        ''}
        ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
          # Single-instance guard (dezren39/nix#1117): with
          # KillMode=process and a handed-over socket, a predecessor
          # that survived a restart keeps accepting connections as
          # an untracked process. Clear any leftover server bound
          # for this port before starting; fail the start if one
          # will not drain.
          stale_pids=""
          for proc in /proc/[0-9]*; do
            [ -r "$proc/cmdline" ] || continue
            cmdline="$(tr '\0' ' ' < "$proc/cmdline")"
            case "$cmdline" in
            *"openchamber serve"*"--port ${toString cfg.port}"*|*"openchamber serve"*"--port=${toString cfg.port}"*|*"cli.js serve"*"--port ${toString cfg.port}"*|*"cli.js serve"*"--port=${toString cfg.port}"*)
              stale_pids="$stale_pids ''${proc#/proc/}"
              ;;
            esac
          done
          if [ -n "$stale_pids" ]; then
            # shellcheck disable=SC2086
            kill -TERM $stale_pids 2>/dev/null || true
            for _ in $(seq 1 50); do
              alive=""
              for pid in $stale_pids; do
                [ -d "/proc/$pid" ] && alive="$alive $pid"
              done
              [ -z "$alive" ] && break
              sleep 0.2
            done
            if [ -n "$alive" ]; then
              # shellcheck disable=SC2086
              kill -KILL $alive 2>/dev/null || true
              sleep 0.2
              for pid in $alive; do
                if [ -d "/proc/$pid" ]; then
                  echo "openchamber: refusing to start — a previous server (pid $pid) will not drain" >&2
                  exit 1
                fi
              done
            fi
          fi
        ''}
        exec "${cfg.package}/bin/openchamber" serve --foreground --port ${toString cfg.port} --host ${cfg.hostname}
      '';
    };
  };

}
