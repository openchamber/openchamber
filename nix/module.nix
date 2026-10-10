self:
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
  options.services.openchamber = {
    enable = lib.mkEnableOption "OpenChamber, the web UI for OpenCode";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.openchamber;
      defaultText = lib.literalExpression "self.packages.${pkgs.stdenv.hostPlatform.system}.openchamber";
      description = "The OpenChamber package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Interface to bind the web UI to. Bind 0.0.0.0 only together with a UI password.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "TCP port for the web UI.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the firewall for {option}`services.openchamber.port`.";
    };

    uiPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/openchamber-ui-password";
      description = ''
        File containing the UI password, exposed as OPENCHAMBER_UI_PASSWORD.
        Required when binding beyond localhost.
      '';
    };

    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "fabio";
      description = ''
        Run the service as this existing user, with HOME=/home/<user>, so it
        sees the same projects, ssh keys, and opencode config as a manual
        `nix run` (mirrors the user units in packages/web/README.md). Leave
        null to run under an isolated dynamic user with state in
        /var/lib/openchamber.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.openchamber = {
      description = "OpenChamber web UI for OpenCode";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        HOME = if cfg.user != null then "/home/${cfg.user}" else "/var/lib/openchamber";
        OPENCODE_CONFIG_DIR =
          if cfg.user != null then
            "/home/${cfg.user}/.config/opencode"
          else
            "/var/lib/openchamber/.config/opencode";
        LANG = "C.UTF-8";
        NODE_ENV = "production";
      };

      preStart = lib.optionalString (cfg.uiPasswordFile != null) ''
        echo "OPENCHAMBER_UI_PASSWORD=$(cat ${cfg.uiPasswordFile})" > /run/openchamber/env
      '';

      serviceConfig = {
        Type = "simple";
        RuntimeDirectory = "openchamber";
        EnvironmentFile = lib.mkIf (cfg.uiPasswordFile != null) "/run/openchamber/env";
        ExecStart = "${cfg.package}/bin/openchamber serve --host ${cfg.host} --port ${toString cfg.port} --foreground";
        Restart = "on-failure";
        RestartSec = 5;

        # Light hardening: the service shells out to git, ssh, and opencode,
        # so keep the sandbox permissive enough for subprocesses. ProtectHome
        # is only for the dynamic user; user mode must see /home.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "full";
      }
      // (
        if cfg.user != null then
          {
            User = cfg.user;
            Group = cfg.user;
          }
        else
          {
            DynamicUser = true;
            StateDirectory = "openchamber";
            ProtectHome = true;
          }
      );
    };
  };
}
