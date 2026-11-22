# SPDX-License-Identifier: MIT OR Apache-2.0
#
# openchamber module — home-manager.
#
# Canonical home: developing-today-forks/openchamber, nix/modules
# (openchamber#1440). The Linux branch installs the same systemd
# user service + socket as nixos.nix (see it for the
# socket/KillMode/NotifyAccess rationale). The darwin branch
# installs a launchd user agent: no socket unit (the server binds
# the port itself), no MAINPID handoff (that protocol is
# systemd's; the agent simply supervises the wrapper, with
# KeepAlive SuccessfulExit = false as launchd's on-failure).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.openchamber;
  home = config.home.homeDirectory;
  path = lib.makeBinPath [
    config.services.mcpx.package
    pkgs.git
    pkgs.openssh
  ];
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf (!pkgs.stdenv.hostPlatform.isDarwin) {
        systemd.user.services.openchamber = {
          Unit = {
            Description = "OpenChamber server";
            After = [
              "mcpx.service"
              "openchamber.socket"
            ];
            Wants = [ "mcpx.service" ];
            Requires = [ "openchamber.socket" ];
          };
          Service = {
            ExecStart = "${cfg.startWrapper}/bin/openchamber-start";
            ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
            KillMode = "process";
            NotifyAccess = "all";
            Restart = "on-failure";
            RestartSec = 5;
            WorkingDirectory = "%h";
            Environment = [ "PATH=${path}" ]
              ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.environment;
          };
          Install.WantedBy = [ "default.target" ];
        };

        systemd.user.sockets.openchamber = {
          Socket.ListenStream = "${cfg.hostname}:${toString cfg.port}";
          Install.WantedBy = [ "sockets.target" ];
        };
      })

      (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
        launchd.agents.openchamber = {
          enable = true;
          config = {
            ProgramArguments = [ "${cfg.startWrapper}/bin/openchamber-start" ];
            EnvironmentVariables = {
              HOME = home;
              PATH = "${path}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin";
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
      })
    ]
  );
}
