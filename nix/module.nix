self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.openchamber;
  # The user's real home directory, derived from the declarative user:
  # homes are not always /home/<name> (custom home, root), and a user
  # declared outside this configuration has no entry to derive from, so
  # fall back to the conventional path there.
  homeDir =
    if cfg.user == null then
      "/var/lib/openchamber"
    else
      let
        declared = config.users.users.${cfg.user}.home or null;
      in
      if declared != null && declared != "" then declared else "/home/${cfg.user}";
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
        Read through systemd's LoadCredential, so a root-owned 0400 secret
        (the usual sops/agenix setup) works with the dynamic user.
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
        HOME = homeDir;
        OPENCODE_CONFIG_DIR = "${homeDir}/.config/opencode";
        LANG = "C.UTF-8";
        NODE_ENV = "production";
      };

      # Mirror the Docker entrypoint's bootstrap: a keyless container gets an
      # SSH identity generated for its git/ssh subprocesses. A dynamic user is
      # the NixOS analogue — service-owned state, no user keys involved.
      # Named users manage their own keys and are never touched.
      preStart =
        lib.optionalString (cfg.uiPasswordFile != null) ''
          umask 077
          echo "OPENCHAMBER_UI_PASSWORD=$(cat "$CREDENTIALS_DIRECTORY/ui-password")" > /run/openchamber/env
        ''
        + lib.optionalString (cfg.user == null) ''
          sshDir="$HOME/.ssh"
          ${pkgs.coreutils}/bin/mkdir -p "$sshDir"
          ${pkgs.coreutils}/bin/chmod 700 "$sshDir" 2>/dev/null || true
          if [ ! -f "$sshDir/id_ed25519" ]; then
            ${pkgs.openssh}/bin/ssh-keygen -t ed25519 -N "" -f "$sshDir/id_ed25519" >/dev/null 2>&1 || true
          fi
        '';

      serviceConfig = {
        Type = "simple";
        RuntimeDirectory = "openchamber";
        # The "-" prefix: the file is written by preStart and must not fail
        # the environment load on the first start (systemd loads
        # EnvironmentFile for preStart too, before the file exists).
        # LoadCredential hands the secret to the service through
        # $CREDENTIALS_DIRECTORY: systemd reads the file as root before the
        # dynamic user takes over, so a root-owned 0400 secret (the usual
        # sops/agenix setup) works without a named user.
        EnvironmentFile = lib.mkIf (cfg.uiPasswordFile != null) "-/run/openchamber/env";
        LoadCredential = lib.mkIf (cfg.uiPasswordFile != null) "ui-password:${cfg.uiPasswordFile}";
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
            # No Group: systemd resolves the user's primary group, which is
            # not always same-named (NixOS defaults to the "users" group).
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
