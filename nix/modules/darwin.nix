# SPDX-License-Identifier: MIT OR Apache-2.0
#
# openchamber module — nix-darwin.
#
# Canonical home: developing-today-forks/openchamber, nix/modules
# (openchamber#1440). Installs the OpenChamber server as a
# launchd user agent running the shared start wrapper (see
# common.nix for the attach contract it enforces). No socket
# unit on darwin: the server binds its port itself.
# KeepAlive's SuccessfulExit = false is launchd's on-failure —
# a clean exit is left down, a crash is restarted.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.openchamber;
  home = config.users.users.${config.system.primaryUser}.home;
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable {
    launchd.user.agents.openchamber.serviceConfig = {
      ProgramArguments = [ "${cfg.startWrapper}/bin/openchamber-start" ];
      EnvironmentVariables = {
        HOME = home;
        PATH = "${
          lib.makeBinPath [
            config.services.mcpx.package
            pkgs.git
            pkgs.openssh
          ]
        }:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin";
      }
      // cfg.environment;
      KeepAlive = {
        SuccessfulExit = false;
      };
      RunAtLoad = true;
      WorkingDirectory = home;
      StandardOutPath = "${home}/Library/Logs/openchamber.log";
      StandardErrorPath = "${home}/Library/Logs/openchamber.log";
    };
  };
}
