/**
 * Antigravity Provider - Client identity
 *
 * Headers that identify quota requests as the Antigravity client. Web/Electron
 * and VS Code both import this module.
 * @module quota/providers/antigravity/client
 */

// Google gates the "Gemini Models" group of `retrieveUserQuotaSummary` by the
// client version in the User-Agent: with `antigravity/1.11.5` it answers with
// the Claude/GPT group alone, so the Gemini rows vanish without an error.
// Keep this at the version Antigravity's own updater offers; to check it, read
// the `version:` line of
// https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml
export const ANTIGRAVITY_CLIENT_VERSION = '2.24.0';

const OS_NAMES = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCH_NAMES = { x64: 'amd64', arm64: 'arm64' };

// The platform part names the machine OpenChamber runs on, in the Go-style
// `os/arch` form Antigravity sends (other maintained Antigravity clients send
// `darwin/arm64` and `darwin/amd64` next to `windows/amd64`). Anything else
// keeps the pair this provider has always sent.
export const antigravityUserAgent = (platform = process.platform, arch = process.arch) => {
  const os = OS_NAMES[platform];
  const platformPart = os ? `${os}/${ARCH_NAMES[arch] ?? 'amd64'}` : 'windows/amd64';
  return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${platformPart}`;
};

export const antigravityHeaders = () => ({
  'User-Agent': antigravityUserAgent(),
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
});

const isThirdPartyGroup = (group) => /claude|gpt|3p/.test((group?.displayName || '').toLowerCase());

let warnedMissingGemini = false;

// A summary with groups but none for Gemini is what an outdated client version
// gets back. Warn once per process so the server log points at the constant
// above instead of the rows disappearing silently.
export const warnIfGeminiGroupMissing = (summaryPayload, warn = console.warn) => {
  const groups = Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [];
  if (warnedMissingGemini || groups.length === 0 || !groups.every(isThirdPartyGroup)) {
    return;
  }
  warnedMissingGemini = true;
  warn(
    `Antigravity quota: Google returned no Gemini quota group, so the Gemini rows are missing. `
      + `If Antigravity itself shows Gemini limits, ANTIGRAVITY_CLIENT_VERSION (${ANTIGRAVITY_CLIENT_VERSION}) `
      + 'in quota/providers/antigravity/client.js is probably out of date.'
  );
};
