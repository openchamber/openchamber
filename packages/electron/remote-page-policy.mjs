// What a remote host's page may hand to, or read from, the desktop shell.
// These IPC commands are remote-safe (main.mjs COMMANDS_SAFE_FOR_REMOTE), so
// their payloads are the boundary between one server and the local app.

// Splash colours are written into the splash page's <style>, and that page
// runs on the trusted openchamber-ui://app origin. Only a plain colour value
// is accepted: anything that could close the declaration is not.
const SPLASH_COLOR_PATTERN = /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([\d.,%\s/+-]*\))$/i;

export const isSplashColor = (value) => SPLASH_COLOR_PATTERN.test(String(value));

// A remote page may list the saved hosts (its host switcher), but the
// credentials of every host stay with local pages: one server must not read
// the tokens or auth headers the user saved for another.
export const redactHostsConfigForRemote = (config) => ({
  ...config,
  hosts: config.hosts.map(({ clientToken: _clientToken, requestHeaders: _requestHeaders, ...host }) => host),
});
