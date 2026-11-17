# SPDX-License-Identifier: MIT OR Apache-2.0
#
# openchamber module — NixOS.
#
# Canonical home: developing-today-forks/openchamber, nix/modules
# (openchamber#1440). Installs the OpenChamber server as a
# systemd *user* service plus its socket unit, mirroring the live
# deployment's shape (which was hand-assembled in another repo's
# home-manager config until now):
#
# - socket activation: the socket unit holds 127.0.0.1:3000
#   across restarts so connections queue instead of being
#   refused; the server prefers the inherited fd when systemd
#   hands it one and binds the port itself otherwise;
# - KillMode = process + NotifyAccess = all: the server hands
#   itself over to a successor on upgrade and sd-notifies the new
#   MAINPID — killing the control group, or ignoring the notify,
#   would take the successor down with the predecessor;
# - Restart = on-failure with a 5 s delay: the start wrapper
#   refuses to start until the standing opencode server's
#   registration exists, and this policy is the retry loop for
#   that wait;
# - After/Wants mcpx.service only: OpenChamber reaches its
#   provider proxies by port, but the mcpx daemon is a real
#   dependency, and mcpx's bin leads the PATH (the server spawns
#   MCP-adjacent tooling through it).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.openchamber;
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable {
    systemd.user.services.openchamber = {
      description = "OpenChamber server";
      after = [
        "mcpx.service"
        "openchamber.socket"
      ];
      wants = [ "mcpx.service" ];
      requires = [ "openchamber.socket" ];
      wantedBy = [ "default.target" ];
      environment = {
        PATH = lib.makeBinPath [
          config.services.mcpx.package
          pkgs.git
          pkgs.openssh
        ];
      }
      // cfg.environment;
      serviceConfig = {
        ExecStart = "${cfg.startWrapper}/bin/openchamber-start";
        ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
        KillMode = "process";
        NotifyAccess = "all";
        Restart = "on-failure";
        RestartSec = 5;
        WorkingDirectory = "%h";
      };
    };

    systemd.user.sockets.openchamber = {
      description = "OpenChamber listener";
      wantedBy = [ "sockets.target" ];
      socketConfig.ListenStream = "${cfg.hostname}:${toString cfg.port}";
    };
  };
}
